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

interface JournalLike {
  append(event: BrokerEvent): Promise<void>;
}

interface Controller {
  clientId: string;
  output: OutputSink;
}

interface RuntimeSession {
  record: SessionRecord;
  pty: PtyHandle;
  controller?: Controller;
  watchers: Map<string, OutputSink>;
  stopRequested: boolean;
}

export interface SessionRegistryOptions {
  adapters: Record<"codex" | "claude", ProviderAdapter>;
  ptyFactory: PtyFactory;
  journal: JournalLike;
  config: BrokerRuntimeConfig;
}

export class RegistryError extends Error {
  constructor(
    readonly code: StartPolicyCode | "SESSION_NOT_FOUND" | "SESSION_ALREADY_CONTROLLED" | "NOT_SESSION_CONTROLLER",
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, RuntimeSession>();

  constructor(private readonly options: SessionRegistryOptions) {}

  async start(request: StartSessionRequest): Promise<SessionRecord> {
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
    const pty = this.options.ptyFactory(
      adapter.buildLaunchSpec(provisional),
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
  ): Promise<Buffer> {
    const runtime = this.requireRuntime(sessionId);
    if (mode === "control") {
      if (runtime.controller !== undefined && runtime.controller.clientId !== clientId) {
        throw new RegistryError("SESSION_ALREADY_CONTROLLED", "Session already has a controller");
      }
      runtime.controller = { clientId, output };
      runtime.watchers.delete(clientId);
    } else {
      runtime.watchers.set(clientId, output);
    }
    this.updateAttachmentState(runtime);
    await this.appendEvent("session.attached", sessionId, { clientId, mode });
    return runtime.pty.snapshot();
  }

  async detach(sessionId: string, clientId: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    let detached = false;
    if (runtime.controller?.clientId === clientId) {
      delete runtime.controller;
      detached = true;
    }
    if (runtime.watchers.delete(clientId)) {
      detached = true;
    }
    if (!detached) return;
    this.updateAttachmentState(runtime);
    await this.appendEvent("session.detached", sessionId, { clientId });
  }

  async releaseClient(clientId: string): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      await this.detach(sessionId, clientId);
    }
  }

  async write(sessionId: string, clientId: string | undefined, data: Buffer): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.controller !== undefined && runtime.controller.clientId !== clientId) {
      throw new RegistryError("NOT_SESSION_CONTROLLER", "Another client controls this session");
    }
    runtime.pty.write(data);
    await this.appendEvent("session.input", sessionId, { bytes: data.length });
  }

  resize(sessionId: string, clientId: string | undefined, cols: number, rows: number): void {
    const runtime = this.requireRuntime(sessionId);
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
  }

  async stopAll(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      await this.stop(sessionId);
    }
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
    runtime.controller?.output(chunk);
    for (const output of runtime.watchers.values()) {
      output(chunk);
    }
  }

  private handleExit(runtime: RuntimeSession, exitCode: number, signal?: number): void {
    runtime.record.executionState = runtime.stopRequested
      ? "cancelled"
      : exitCode === 0
        ? "exited"
        : "failed";
    runtime.record.exitCode = exitCode;
    runtime.record.updatedAt = new Date().toISOString();
    void this.appendEvent("session.exited", runtime.record.id, {
      exitCode,
      signal: signal ?? null,
    });
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
