import { randomUUID } from "node:crypto";
import type { BrokerRuntimeConfig } from "../config.js";
import type { BrokerEvent, BrokerEventType } from "../domain/events.js";
import { evaluateStart, type SessionAncestryEntry, type StartPolicyCode } from "../domain/policy.js";
import {
  StartSessionRequestSchema,
  type SessionRecord,
  type StartSessionRequest,
} from "../domain/session.js";
import type { ProviderAdapter, ProviderLaunchSpec } from "../providers/provider.js";
import type { ThreadTranscriptStore } from "../persistence/thread-transcript-store.js";

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
  pty: PtyHandle;
  controller?: Controller;
  watchers: Map<string, Watcher>;
  stopRequested: boolean;
}

export interface SessionRegistryOptions {
  adapters: Record<"codex" | "claude", ProviderAdapter>;
  ptyFactory: PtyFactory;
  journal: JournalLike;
  transcripts?: ThreadTranscriptStore;
  config: BrokerRuntimeConfig;
}

export class RegistryError extends Error {
  constructor(
    readonly code:
      | StartPolicyCode
      | "SESSION_NOT_FOUND"
      | "SESSION_ALREADY_CONTROLLED"
      | "SESSION_NOT_ACTIVE"
      | "SESSION_ALREADY_ACTIVE"
      | "NOT_SESSION_CONTROLLER"
      | "SESSION_BUSY"
      | "SESSION_STILL_ACTIVE"
      | "SESSION_HAS_CHILDREN",
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly controllerReleasedListeners = new Set<(sessionId: string) => void>();

  constructor(private readonly options: SessionRegistryOptions) {}

  onControllerReleased(listener: (sessionId: string) => void): () => void {
    this.controllerReleasedListeners.add(listener);
    return () => this.controllerReleasedListeners.delete(listener);
  }

  async start(request: StartSessionRequest, initialPrompt?: string): Promise<SessionRecord> {
    const parsed = StartSessionRequestSchema.parse(request);
    const ancestry = this.resolveAncestry(parsed.parentSessionId);
    const decision = evaluateStart(parsed, ancestry, {
      activeSessionCount: this.activeSessionCount(),
      maxConcurrentSessions: this.options.config.maxConcurrentSessions,
      maxDelegationDepth: this.options.config.maxDelegationDepth,
    });
    if (!decision.allowed) {
      throw new RegistryError(decision.code, decision.code);
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
    };
    const adapter = this.options.adapters[parsed.provider];
    const launchSpec = adapter.buildLaunchSpec(provisional, initialPrompt);
    if (initialPrompt !== undefined) {
      await this.options.transcripts?.append({
        sessionId: id,
        kind: "prompt",
        source: "human",
        text: initialPrompt,
        data: { initial: true },
      });
    }
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
    };
    this.sessions.set(id, runtime);
    pty.onOutput((chunk) => this.broadcast(runtime, chunk));
    pty.onExit((exitCode, signal) => this.handleExit(runtime, exitCode, signal));

    if (parsed.parentSessionId !== undefined) {
      const parent = this.requireRuntime(parsed.parentSessionId);
      parent.record.childIds.push(id);
      parent.record.updatedAt = new Date().toISOString();
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

  get(sessionId: string): SessionRecord {
    return this.cloneRecord(this.requireRuntime(sessionId).record);
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
    return runtime.pty.snapshot();
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
    runtime.pty.write(data);
    await this.appendEvent("session.input", sessionId, { bytes: data.length });
  }

  async submit(sessionId: string, clientId: string | undefined, message: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    const adapter = this.options.adapters[runtime.record.provider];
    const data = adapter.submitInput?.(message) ?? Buffer.from(`${message}\n`);
    await this.appendTranscript(sessionId, "prompt", "human", message, {});
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
    const adapter = this.options.adapters[runtime.record.provider];
    const encoded = adapter.submitInput?.(message) ?? Buffer.from(`${message}\n`);
    await this.appendTranscript(sessionId, "instruction", source, message, metadata);
    if (runtime.controller !== undefined) {
      throw new RegistryError("SESSION_BUSY", "A human controller claimed this thread before delivery");
    }
    runtime.pty.write(encoded);
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
    runtime.pty.resize(cols, rows);
  }

  snapshot(sessionId: string): Buffer {
    return this.requireRuntime(sessionId).pty.snapshot();
  }

  async stop(sessionId: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.stopRequested || runtime.record.executionState !== "active") return;
    runtime.stopRequested = true;
    runtime.record.executionState = "cancelled";
    runtime.record.updatedAt = new Date().toISOString();
    runtime.pty.kill();
    await this.appendEvent("session.stopped", sessionId, {});
    await this.appendTranscript(sessionId, "lifecycle", "broker", "session stopped", {});
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

    const adapter = this.options.adapters[runtime.record.provider];
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
      }
    }
    this.sessions.delete(sessionId);
  }

  private activeSessionCount(): number {
    return [...this.sessions.values()].filter(({ record }) => record.executionState === "active").length;
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
    void this.appendTranscript(runtime.record.id, "output", "provider", chunk.toString("utf8"), {
      byteLength: chunk.byteLength,
    }).catch(() => undefined);
    runtime.controller?.output(chunk);
    for (const watcher of runtime.watchers.values()) {
      watcher.output(chunk);
    }
  }

  private handleExit(runtime: RuntimeSession, exitCode: number, signal?: number): void {
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
