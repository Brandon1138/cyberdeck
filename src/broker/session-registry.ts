import { randomUUID } from "node:crypto";
import type { BrokerRuntimeConfig } from "../config.js";
import type { BrokerEvent, BrokerEventType } from "../domain/events.js";
import { evaluateStart, type SessionAncestryEntry, type StartPolicyCode } from "../domain/policy.js";
import {
  StartSessionRequestSchema,
  type SessionRecord,
  type StartSessionRequest,
  type ThreadAttentionState,
} from "../domain/session.js";
import type { ProviderAdapter, ProviderLaunchSpec } from "../providers/provider.js";
import type { ThreadTranscriptStore } from "../persistence/thread-transcript-store.js";
import { applyWorkerMode } from "../providers/worker-mode.js";
import {
  compactTerminalResult,
  latestAssistantParagraphPreview,
  providerTerminalActivity,
  type ProviderTerminalActivity,
} from "../runtime/terminal-replay.js";

export interface PtyHandle {
  readonly pid: number;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  snapshot(): Buffer;
  kill(signal?: string): void;
  onOutput(listener: (chunk: Buffer) => void): () => void;
  onExit(listener: (exitCode: number, signal?: number) => void): () => void;
}

export type PtyFactory = (spec: ProviderLaunchSpec, replayBytes: number) => PtyHandle;
export type AttachmentMode = "control" | "watch";
export type OutputSink = (chunk: Buffer) => void;
export type ExitSink = (exitCode: number) => void;

interface JournalLike {
  append(event: BrokerEvent): Promise<void>;
}

interface SessionStoreLike {
  put(record: SessionRecord): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

interface Controller {
  clientId: string;
  output: OutputSink;
  ended: ExitSink;
}

interface Watcher {
  output: OutputSink;
  ended: ExitSink;
}

interface RuntimeSession {
  record: SessionRecord;
  pty?: PtyHandle;
  controller?: Controller;
  watchers: Map<string, Watcher>;
  stopRequested: boolean;
  activity: ProviderTerminalActivity;
  observedWorking: boolean;
  completedTurns: number;
  latestResult?: string;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface WorkerWaitTarget {
  sessionId: string;
  completionTarget: number;
}

export interface WorkerResultSnapshot {
  sessionId: string;
  name?: string;
  provider: string;
  model?: string;
  effort?: string;
  status: "completed" | "blocked" | "working" | "waiting" | "failed" | "stopped" | "exited";
  completedTurns: number;
  text: string;
}

export interface WorkerWaitResult {
  timedOut: boolean;
  results: WorkerResultSnapshot[];
}

export interface SessionTreeProgress {
  rootSessionId: string;
  rootKind: "worker" | "orchestrator";
  childCount: number;
  total: number;
  active: number;
  stopping: number;
  terminal: number;
}

export interface SessionTreeDeleteResult extends SessionTreeProgress {
  deleted: number;
}

export interface SessionRegistryOptions {
  adapters: Record<string, ProviderAdapter>;
  ptyFactory: PtyFactory;
  journal: JournalLike;
  transcripts?: ThreadTranscriptStore;
  store?: SessionStoreLike;
  recoveredSessions?: readonly SessionRecord[];
  config: BrokerRuntimeConfig;
}

export class RegistryError extends Error {
  constructor(
    readonly code:
      | StartPolicyCode
      | "PROVIDER_NOT_REGISTERED"
      | "SESSION_NOT_FOUND"
      | "SESSION_ALREADY_CONTROLLED"
      | "SESSION_NOT_ACTIVE"
      | "SESSION_ALREADY_ACTIVE"
      | "NOT_SESSION_CONTROLLER"
      | "SESSION_BUSY"
      | "SESSION_STILL_ACTIVE"
      | "SESSION_HAS_CHILDREN"
      | "SESSION_TREE_STILL_ACTIVE"
      | "PARENT_SESSION_NOT_ACTIVE",
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly controllerReleasedListeners = new Set<(sessionId: string) => void>();
  private readonly sessionUpdateListeners = new Set<(sessionId: string) => void>();
  private readonly recovery: Promise<void>;

  constructor(private readonly options: SessionRegistryOptions) {
    const writes: Promise<void>[] = [];
    for (const stored of options.recoveredSessions ?? []) {
      const record = this.recoverRecord(stored);
      this.sessions.set(record.id, {
        record,
        watchers: new Map(),
        stopRequested: false,
        activity: "unknown",
        observedWorking: false,
        completedTurns: 0,
      });
      if (record.attentionState === "interrupted") {
        writes.push(this.options.store?.put(this.cloneRecord(record)) ?? Promise.resolve());
      }
    }
    this.recovery = Promise.all(writes).then(() => undefined);
  }

  async ready(): Promise<void> {
    await this.recovery;
  }

  onControllerReleased(listener: (sessionId: string) => void): () => void {
    this.controllerReleasedListeners.add(listener);
    return () => this.controllerReleasedListeners.delete(listener);
  }

  async start(request: StartSessionRequest, initialPrompt?: string): Promise<SessionRecord> {
    const parsed = StartSessionRequestSchema.parse(request);
    this.requireActiveParent(parsed.parentSessionId);
    const ancestry = this.resolveAncestry(parsed.parentSessionId);
    const decision = evaluateStart(parsed, ancestry, {
      activeWorkerCount: this.activeWorkerCount(),
      maxConcurrentWorkers: this.options.config.maxConcurrentWorkers,
      maxDelegationDepth: this.options.config.maxDelegationDepth,
    });
    if (!decision.allowed) {
      const message = decision.code === "MAX_CONCURRENT_WORKERS"
        ? `Worker limit reached: ${decision.activeWorkers ?? 0} active / ${decision.maxConcurrentWorkers ?? "unknown"} allowed`
        : decision.code;
      throw new RegistryError(decision.code, message);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const provisional: SessionRecord = {
      ...parsed,
      kind: parsed.kind ?? "worker",
      id,
      createdAt: now,
      updatedAt: now,
      executionState: "starting",
      attachmentState: "detached",
      pid: 1,
      exitCode: null,
      childIds: [],
      attentionState: initialPrompt === undefined ? "done" : "working",
      meaningfulUpdatedAt: now,
    };
    const adapter = this.requireAdapter(parsed.provider);
    const launchSpec = adapter.buildLaunchSpec(
      provisional,
      initialPrompt === undefined ? undefined : applyWorkerMode(initialPrompt, provisional.workerMode),
    );
    if (adapter.prepareLaunch !== undefined) await adapter.prepareLaunch(provisional, launchSpec);
    this.requireActiveParent(parsed.parentSessionId);
    if (initialPrompt !== undefined) {
      await this.options.transcripts?.append({
        sessionId: id,
        kind: "prompt",
        source: "human",
        text: initialPrompt,
        data: { initial: true },
      });
    }
    this.requireActiveParent(parsed.parentSessionId);
    const pty = this.options.ptyFactory(
      launchSpec,
      this.options.config.replayBytes,
    );
    const record: SessionRecord = {
      ...provisional,
      pid: pty.pid,
      executionState: "active",
      updatedAt: new Date().toISOString(),
    };
    const runtime: RuntimeSession = {
      record,
      pty,
      watchers: new Map(),
      stopRequested: false,
      activity: "unknown",
      observedWorking: false,
      completedTurns: 0,
    };
    this.sessions.set(id, runtime);
    pty.onOutput((chunk) => this.broadcast(runtime, chunk));
    pty.onExit((exitCode, signal) => this.handleExit(runtime, exitCode, signal));

    if (parsed.parentSessionId !== undefined) {
      const parent = this.requireRuntime(parsed.parentSessionId);
      parent.record.childIds.push(id);
      parent.record.updatedAt = new Date().toISOString();
      await this.persist(parent);
    }

    try {
      await this.appendEvent("session.created", id, {
        provider: record.provider,
        model: record.model ?? null,
        role: record.role ?? null,
        parentSessionId: record.parentSessionId ?? null,
        pid: record.pid,
      });
      await this.appendTranscript(id, "lifecycle", "broker", "session created", {
        provider: record.provider,
        model: record.model ?? null,
      });
      await this.persist(runtime);
    } catch (error) {
      pty.kill();
      this.sessions.delete(id);
      throw error;
    }

    return this.cloneRecord(record);
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()].map(({ record }) => this.cloneRecord(record));
  }

  workerCapacity(): { activeWorkers: number; maxConcurrentWorkers: number | null } {
    return {
      activeWorkers: this.activeWorkerCount(),
      maxConcurrentWorkers: this.options.config.maxConcurrentWorkers,
    };
  }

  get(sessionId: string): SessionRecord {
    return this.cloneRecord(this.requireRuntime(sessionId).record);
  }

  async waitForWorkerResults(
    targets: readonly WorkerWaitTarget[],
    timeoutMs: number,
    maxResultChars = 1_200,
  ): Promise<WorkerWaitResult> {
    const boundedTimeout = Math.max(1_000, Math.min(timeoutMs, 600_000));
    const snapshot = (): WorkerResultSnapshot[] => targets.map((target) =>
      this.workerResultSnapshot(target, maxResultChars)
    );
    const isSettled = (result: WorkerResultSnapshot): boolean =>
      result.status !== "working" && result.status !== "waiting";

    const initial = snapshot();
    if (initial.every(isSettled)) return { timedOut: false, results: initial };

    return new Promise<WorkerWaitResult>((resolve) => {
      let settled = false;
      const finish = (timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.sessionUpdateListeners.delete(onUpdate);
        resolve({ timedOut, results: snapshot() });
      };
      const targetIds = new Set(targets.map(({ sessionId }) => sessionId));
      const onUpdate = (sessionId: string) => {
        if (!targetIds.has(sessionId)) return;
        if (snapshot().every(isSettled)) finish(false);
      };
      const timer = setTimeout(() => finish(true), boundedTimeout);
      this.sessionUpdateListeners.add(onUpdate);
      if (snapshot().every(isSettled)) finish(false);
    });
  }

  async attach(
    sessionId: string,
    clientId: string,
    mode: AttachmentMode,
    output: OutputSink,
    ended: ExitSink = () => {},
  ): Promise<Buffer> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.record.executionState !== "active") {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session is not active; resume it before attaching");
    }
    const pty = this.requirePty(runtime);
    if (mode === "control") {
      if (runtime.controller !== undefined && runtime.controller.clientId !== clientId) {
        throw new RegistryError("SESSION_ALREADY_CONTROLLED", "Session already has a controller");
      }
      runtime.controller = { clientId, output, ended };
      runtime.watchers.delete(clientId);
    } else {
      runtime.watchers.set(clientId, { output, ended });
    }
    this.updateAttachmentState(runtime);
    try {
      await this.appendEvent("session.attached", sessionId, { clientId, mode });
    } catch (error) {
      if (runtime.controller?.clientId === clientId) delete runtime.controller;
      runtime.watchers.delete(clientId);
      this.updateAttachmentState(runtime);
      throw error;
    }
    return pty.snapshot();
  }

  async detach(sessionId: string, clientId: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    let detached = false;
    let controllerReleased = false;
    if (runtime.controller?.clientId === clientId) {
      delete runtime.controller;
      detached = true;
      controllerReleased = true;
    }
    if (runtime.watchers.delete(clientId)) {
      detached = true;
    }
    if (!detached) return;
    this.updateAttachmentState(runtime);
    await this.appendEvent("session.detached", sessionId, { clientId });
    if (controllerReleased) {
      for (const listener of this.controllerReleasedListeners) listener(sessionId);
    }
  }

  async releaseClient(clientId: string): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      await this.detach(sessionId, clientId);
    }
  }

  async write(sessionId: string, clientId: string | undefined, data: Buffer): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.record.executionState !== "active") {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session is not active");
    }
    if (runtime.controller !== undefined && runtime.controller.clientId !== clientId) {
      throw new RegistryError("NOT_SESSION_CONTROLLER", "Another client controls this session");
    }
    this.requirePty(runtime).write(data);
    await this.appendEvent("session.input", sessionId, { bytes: data.length });
  }

  async submit(sessionId: string, clientId: string | undefined, message: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    const adapter = this.requireAdapter(runtime.record.provider);
    const data = adapter.submitInput?.(message) ?? Buffer.from(`${message}\n`);
    await this.appendTranscript(sessionId, "prompt", "human", message, {});
    await this.setAttention(runtime, "working", true);
    await this.write(sessionId, clientId, data);
  }

  async submitInstruction(
    sessionId: string,
    message: string,
    source: "orchestrator" | "worker" = "orchestrator",
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.record.executionState !== "active") {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session is not active");
    }
    if (runtime.controller !== undefined) {
      throw new RegistryError("SESSION_BUSY", "A human controller currently owns this thread");
    }
    const adapter = this.requireAdapter(runtime.record.provider);
    const encoded = adapter.submitInput?.(message) ?? Buffer.from(`${message}\n`);
    await this.appendTranscript(sessionId, "instruction", source, message, metadata);
    if (runtime.controller !== undefined) {
      throw new RegistryError("SESSION_BUSY", "A human controller claimed this thread before delivery");
    }
    await this.setAttention(runtime, "working", true);
    this.requirePty(runtime).write(encoded);
    await this.appendEvent("session.input", sessionId, { bytes: encoded.length, source });
  }

  resize(sessionId: string, clientId: string | undefined, cols: number, rows: number): void {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.record.executionState !== "active") {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session is not active");
    }
    if (runtime.controller !== undefined && runtime.controller.clientId !== clientId) {
      throw new RegistryError("NOT_SESSION_CONTROLLER", "Another client controls this session");
    }
    this.requirePty(runtime).resize(cols, rows);
  }

  snapshot(sessionId: string): Buffer {
    return this.requireRuntime(sessionId).pty?.snapshot() ?? Buffer.alloc(0);
  }

  async stop(sessionId: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.record.exitCode !== null) return;
    if (runtime.stopRequested) {
      this.requirePty(runtime).kill();
      return;
    }
    if (runtime.record.executionState !== "active") return;
    runtime.stopRequested = true;
    runtime.record.executionState = "cancelled";
    await this.setAttention(runtime, "stopping", true);
    this.requirePty(runtime).kill();
    await this.appendEvent("session.stopped", sessionId, {});
    await this.appendTranscript(sessionId, "lifecycle", "broker", "session stopped", {});
  }

  async stopTree(sessionId: string): Promise<SessionTreeProgress> {
    const tree = this.sessionTree(sessionId);
    await this.stop(sessionId);
    await Promise.all(tree.slice(1).map((runtime) => this.stop(runtime.record.id)));
    return this.treeProgress(sessionId);
  }

  async stopAll(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      await this.stop(sessionId);
    }
  }

  async resume(sessionId: string): Promise<SessionRecord> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.record.executionState === "active" || runtime.record.executionState === "starting") {
      throw new RegistryError("SESSION_ALREADY_ACTIVE", "Session is already active");
    }

    const adapter = this.requireAdapter(runtime.record.provider);
    const pty = this.options.ptyFactory(
      adapter.buildResumeSpec(this.cloneRecord(runtime.record)),
      this.options.config.replayBytes,
    );
    runtime.pty = pty;
    runtime.stopRequested = false;
    delete runtime.controller;
    runtime.watchers.clear();
    runtime.record.pid = pty.pid;
    runtime.record.executionState = "active";
    runtime.record.attachmentState = "detached";
    runtime.record.exitCode = null;
    runtime.record.updatedAt = new Date().toISOString();
    runtime.record.attentionState = "done";
    runtime.activity = "unknown";
    runtime.observedWorking = false;
    if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);
    delete runtime.idleTimer;
    pty.onOutput((chunk) => this.broadcast(runtime, chunk));
    pty.onExit((exitCode, signal) => this.handleExit(runtime, exitCode, signal));
    await this.appendEvent("session.resumed", sessionId, {
      provider: runtime.record.provider,
      model: runtime.record.model ?? null,
      pid: runtime.record.pid,
    });
    await this.appendTranscript(sessionId, "lifecycle", "broker", "session resumed", {
      pid: runtime.record.pid,
    });
    await this.persist(runtime);
    return this.cloneRecord(runtime.record);
  }

  async delete(sessionId: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    if (
      runtime.record.executionState === "active"
      || runtime.record.executionState === "starting"
      || runtime.record.exitCode === null
    ) {
      throw new RegistryError("SESSION_STILL_ACTIVE", "Stop the agent before deleting its thread");
    }
    const existingChildren = runtime.record.childIds.filter((childId) => this.sessions.has(childId));
    if (existingChildren.length > 0) {
      throw new RegistryError(
        "SESSION_HAS_CHILDREN",
        "Delete this thread's child agents before deleting the parent thread",
      );
    }

    await this.appendEvent("session.deleted", sessionId, {
      executionState: runtime.record.executionState,
    });
    await this.appendTranscript(sessionId, "lifecycle", "broker", "session deleted", {});
    if (runtime.record.parentSessionId !== undefined) {
      const parent = this.sessions.get(runtime.record.parentSessionId);
      if (parent !== undefined) {
        parent.record.childIds = parent.record.childIds.filter((childId) => childId !== sessionId);
        parent.record.updatedAt = new Date().toISOString();
        await this.persist(parent);
      }
    }
    await this.options.store?.delete(sessionId);
    this.sessions.delete(sessionId);
  }

  async deleteTree(
    sessionId: string,
    beforeRootDelete?: () => Promise<void>,
  ): Promise<SessionTreeDeleteResult> {
    const tree = this.sessionTree(sessionId);
    const progress = this.progressForTree(tree);
    if (progress.terminal !== progress.total) {
      throw new RegistryError(
        "SESSION_TREE_STILL_ACTIVE",
        `Stop the full agent tree before deleting it (${progress.terminal}/${progress.total} stopped)`,
      );
    }

    const descendantsLeafFirst = tree.slice(1).reverse();
    for (const runtime of descendantsLeafFirst) await this.delete(runtime.record.id);
    await beforeRootDelete?.();
    await this.delete(sessionId);
    return { ...progress, deleted: progress.total };
  }

  async rename(sessionId: string, name: string): Promise<SessionRecord> {
    const normalized = name.replace(/\s+/gu, " ").trim();
    if (normalized === "") throw new Error("Thread name cannot be empty");
    const runtime = this.requireRuntime(sessionId);
    runtime.record.name = normalized.slice(0, 120);
    runtime.record.updatedAt = new Date().toISOString();
    await this.persist(runtime);
    return this.cloneRecord(runtime.record);
  }

  async togglePin(sessionId: string): Promise<SessionRecord> {
    const runtime = this.requireRuntime(sessionId);
    runtime.record.pinned = runtime.record.pinned !== true;
    runtime.record.updatedAt = new Date().toISOString();
    await this.persist(runtime);
    return this.cloneRecord(runtime.record);
  }

  async reorder(sessionId: string, direction: "up" | "down"): Promise<SessionRecord[]> {
    const runtime = this.requireRuntime(sessionId);
    const group = [...this.sessions.values()]
      .filter((candidate) => candidate.record.cwd === runtime.record.cwd)
      .sort((left, right) => this.compareDisplayOrder(left.record, right.record));
    const index = group.findIndex((candidate) => candidate.record.id === sessionId);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= group.length) return group.map(({ record }) => this.cloneRecord(record));
    [group[index], group[target]] = [group[target]!, group[index]!];
    await Promise.all(group.map(async (candidate, displayOrder) => {
      candidate.record.displayOrder = displayOrder;
      candidate.record.updatedAt = new Date().toISOString();
      await this.persist(candidate);
    }));
    return group.map(({ record }) => this.cloneRecord(record));
  }

  private activeWorkerCount(): number {
    return [...this.sessions.values()].filter(({ record }) =>
      record.executionState === "active" && record.kind !== "orchestrator"
    ).length;
  }

  private compareDisplayOrder(left: SessionRecord, right: SessionRecord): number {
    if (left.pinned !== right.pinned) return left.pinned === true ? -1 : 1;
    const leftOrder = left.displayOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.displayOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return (right.meaningfulUpdatedAt ?? right.updatedAt).localeCompare(left.meaningfulUpdatedAt ?? left.updatedAt);
  }

  private resolveAncestry(parentSessionId: string | undefined): SessionAncestryEntry[] {
    if (parentSessionId === undefined) return [];
    const ancestry: SessionAncestryEntry[] = [];
    let current: RuntimeSession | undefined = this.sessions.get(parentSessionId);
    if (current === undefined) {
      throw new RegistryError("SESSION_NOT_FOUND", `Parent session ${parentSessionId} was not found`);
    }
    while (current !== undefined) {
      ancestry.push({
        id: current.record.id,
        parentSessionId: current.record.parentSessionId,
      });
      const nextId: string | undefined = current.record.parentSessionId;
      current = nextId === undefined ? undefined : this.sessions.get(nextId);
    }
    return ancestry;
  }

  private requireRuntime(sessionId: string): RuntimeSession {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) {
      throw new RegistryError("SESSION_NOT_FOUND", `Session ${sessionId} was not found`);
    }
    return runtime;
  }

  private requireActiveParent(parentSessionId: string | undefined): void {
    if (parentSessionId === undefined) return;
    const parent = this.requireRuntime(parentSessionId);
    if (parent.record.executionState !== "active" || parent.stopRequested) {
      throw new RegistryError(
        "PARENT_SESSION_NOT_ACTIVE",
        `Parent session ${parentSessionId} is not active`,
      );
    }
  }

  private sessionTree(sessionId: string): RuntimeSession[] {
    const root = this.requireRuntime(sessionId);
    const ordered: RuntimeSession[] = [];
    const visited = new Set<string>();
    const visit = (runtime: RuntimeSession) => {
      if (visited.has(runtime.record.id)) return;
      visited.add(runtime.record.id);
      ordered.push(runtime);
      for (const childId of runtime.record.childIds) {
        const child = this.sessions.get(childId);
        if (child !== undefined) visit(child);
      }
    };
    visit(root);
    return ordered;
  }

  private treeProgress(sessionId: string): SessionTreeProgress {
    return this.progressForTree(this.sessionTree(sessionId));
  }

  private progressForTree(tree: readonly RuntimeSession[]): SessionTreeProgress {
    const root = tree[0]!;
    const terminal = tree.filter(({ record }) => record.exitCode !== null).length;
    const active = tree.filter(({ record }) =>
      record.executionState === "active" || record.executionState === "starting").length;
    return {
      rootSessionId: root.record.id,
      rootKind: root.record.kind ?? "worker",
      childCount: tree.length - 1,
      total: tree.length,
      active,
      stopping: tree.length - active - terminal,
      terminal,
    };
  }

  private requireAdapter(provider: string): ProviderAdapter {
    const adapter = this.options.adapters[provider];
    if (adapter === undefined) {
      throw new RegistryError(
        "PROVIDER_NOT_REGISTERED",
        `Provider ${provider} is not registered for interactive sessions`,
      );
    }
    return adapter;
  }

  private updateAttachmentState(runtime: RuntimeSession): void {
    runtime.record.attachmentState = runtime.controller !== undefined
      ? "controlled"
      : runtime.watchers.size > 0
        ? "watched"
        : "detached";
    runtime.record.updatedAt = new Date().toISOString();
  }

  private broadcast(runtime: RuntimeSession, chunk: Buffer): void {
    runtime.record.updatedAt = new Date().toISOString();
    const pty = runtime.pty;
    if (pty === undefined) return;
    const replay = pty.snapshot().toString("utf8");
    const activity = providerTerminalActivity(runtime.record.provider, replay);
    if (activity === "working") {
      runtime.observedWorking = true;
      if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);
      delete runtime.idleTimer;
      if (runtime.record.attentionState !== "working") {
        void this.setAttention(runtime, "working", false);
      }
    }
    runtime.activity = activity;
    if (activity === "awaiting-input" && runtime.observedWorking) {
      if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);
      runtime.idleTimer = setTimeout(() => {
        delete runtime.idleTimer;
        if (runtime.activity !== "awaiting-input" || !runtime.observedWorking) return;
        runtime.completedTurns += 1;
        runtime.observedWorking = false;
        const completedReplay = runtime.pty?.snapshot().toString("utf8") ?? replay;
        runtime.latestResult = compactTerminalResult(completedReplay);
        runtime.record.latestPreview = latestAssistantParagraphPreview(completedReplay);
        void this.setAttention(runtime, "done", true);
        this.notifySessionUpdate(runtime.record.id);
      }, 200);
    } else if (activity === "blocked") {
      runtime.latestResult = compactTerminalResult(replay);
      runtime.record.latestPreview = latestAssistantParagraphPreview(replay);
      if (runtime.record.attentionState !== "needs-input") {
        void this.setAttention(runtime, "needs-input", true);
      }
    }
    void this.appendTranscript(runtime.record.id, "output", "provider", chunk.toString("utf8"), {
      byteLength: chunk.byteLength,
    }).catch(() => undefined);
    runtime.controller?.output(chunk);
    for (const watcher of runtime.watchers.values()) {
      watcher.output(chunk);
    }
    this.notifySessionUpdate(runtime.record.id);
  }

  private handleExit(runtime: RuntimeSession, exitCode: number, signal?: number): void {
    if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer);
    delete runtime.idleTimer;
    runtime.record.executionState = runtime.stopRequested
      ? "cancelled"
      : exitCode === 0
        ? "exited"
        : "failed";
    runtime.record.exitCode = exitCode;
    const controller = runtime.controller;
    const watchers = [...runtime.watchers.values()];
    delete runtime.controller;
    runtime.watchers.clear();
    runtime.record.attachmentState = "detached";
    runtime.record.updatedAt = new Date().toISOString();
    runtime.record.attentionState = runtime.stopRequested
      ? "stopped"
      : exitCode === 0
        ? "done"
        : "failed";
    runtime.record.meaningfulUpdatedAt = runtime.record.updatedAt;
    controller?.ended(exitCode);
    for (const watcher of watchers) watcher.ended(exitCode);
    void this.appendEvent("session.exited", runtime.record.id, {
      exitCode,
      signal: signal ?? null,
    });
    void this.appendTranscript(runtime.record.id, "lifecycle", "broker", "session exited", {
      exitCode,
      signal: signal ?? null,
    }).catch(() => undefined);
    void this.persist(runtime);
    this.notifySessionUpdate(runtime.record.id);
  }

  private workerResultSnapshot(target: WorkerWaitTarget, maxResultChars: number): WorkerResultSnapshot {
    const runtime = this.requireRuntime(target.sessionId);
    const replay = runtime.pty?.snapshot().toString("utf8") ?? runtime.record.latestPreview ?? "";
    const text = runtime.latestResult === undefined
      ? compactTerminalResult(replay, maxResultChars)
      : runtime.latestResult.length <= maxResultChars
        ? runtime.latestResult
        : runtime.latestResult.slice(runtime.latestResult.length - maxResultChars);
    const base = {
      sessionId: runtime.record.id,
      ...(runtime.record.name === undefined ? {} : { name: runtime.record.name }),
      provider: runtime.record.provider,
      ...(runtime.record.model === undefined ? {} : { model: runtime.record.model }),
      ...(runtime.record.effort === undefined ? {} : { effort: runtime.record.effort }),
      completedTurns: runtime.completedTurns,
      text,
    };
    if (runtime.completedTurns >= target.completionTarget) return { ...base, status: "completed" };
    if (runtime.activity === "blocked") return { ...base, status: "blocked" };
    if (runtime.record.executionState === "failed") return { ...base, status: "failed" };
    if (runtime.record.executionState === "cancelled") return { ...base, status: "stopped" };
    if (runtime.record.executionState === "exited") return { ...base, status: "exited" };
    if (runtime.activity === "working") return { ...base, status: "working" };
    return { ...base, status: "waiting" };
  }

  private notifySessionUpdate(sessionId: string): void {
    for (const listener of this.sessionUpdateListeners) listener(sessionId);
  }

  private requirePty(runtime: RuntimeSession): PtyHandle {
    if (runtime.pty === undefined) {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session runtime is not active; resume it before use");
    }
    return runtime.pty;
  }

  private async setAttention(
    runtime: RuntimeSession,
    attentionState: ThreadAttentionState,
    meaningful: boolean,
  ): Promise<void> {
    const now = new Date().toISOString();
    runtime.record.attentionState = attentionState;
    runtime.record.updatedAt = now;
    if (meaningful) runtime.record.meaningfulUpdatedAt = now;
    await this.persist(runtime);
  }

  private async persist(runtime: RuntimeSession): Promise<void> {
    await this.options.store?.put(this.cloneRecord(runtime.record));
  }

  private recoverRecord(stored: SessionRecord): SessionRecord {
    const record = this.cloneRecord(stored);
    record.attachmentState = "detached";
    if (record.executionState === "active" || record.executionState === "starting") {
      record.executionState = "cancelled";
      record.exitCode = 0;
      record.attentionState = "interrupted";
      record.updatedAt = new Date().toISOString();
      return record;
    }
    record.attentionState ??= record.executionState === "failed"
      ? "failed"
      : record.executionState === "cancelled"
        ? "stopped"
        : "done";
    if (record.executionState === "cancelled" && record.attentionState === "stopping") {
      record.attentionState = "stopped";
    }
    return record;
  }

  private async appendTranscript(
    sessionId: string,
    kind: "prompt" | "output" | "instruction" | "lifecycle",
    source: "human" | "provider" | "orchestrator" | "worker" | "broker",
    text: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.options.transcripts?.append({ sessionId, kind, source, text, data });
  }

  private async appendEvent(
    type: BrokerEventType,
    sessionId: string | undefined,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.options.journal.append({
      id: randomUUID(),
      type,
      ...(sessionId === undefined ? {} : { sessionId }),
      occurredAt: new Date().toISOString(),
      data,
    });
  }

  private cloneRecord(record: SessionRecord): SessionRecord {
    return { ...record, childIds: [...record.childIds] };
  }
}
