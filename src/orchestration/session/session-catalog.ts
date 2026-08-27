import { randomUUID } from "node:crypto";
import type { BrokerEventType } from "../../domain/events.js";
import type { SessionAncestryEntry } from "../../domain/policy.js";
import type { SessionRecord, ThreadAttentionState } from "../../domain/session.js";
import { MIN_SCOUT_REPLAY_BYTES } from "../../domain/worker-profile.js";
import type { ProviderAdapter } from "./provider-ports.js";
import {
  RegistryError,
  type RuntimeSession,
  type SessionRegistryOptions,
  type SessionTreeProgress,
  type WorkerBudgetGate,
} from "./session-registry-ports.js";
import { cloneRecord, progressForTree } from "./session-record-projection.js";

/**
 * The table of live sessions, and the durable writes that keep it honest.
 *
 * Every collaborator reads the same `sessions` map through this one object rather than holding its
 * own reference, because a session's runtime state and its journal, transcript, and catalog writes
 * have to move together: a record mutated by one path and persisted by another is exactly how a
 * thread ends up durable in a state nothing ever decided.
 */
export class SessionCatalog {
  readonly sessions = new Map<string, RuntimeSession>();
  private workerBudgetGate: WorkerBudgetGate | undefined;

  constructor(readonly options: SessionRegistryOptions) {}

  /**
   * Install one broker-owned budget gate after registry and durable coordination recovery exist.
   * Keeping this at the registry boundary covers attached input, queued instructions, and resume;
   * individual RPC/MCP tools cannot bypass an exhausted hard limit.
   */
  setWorkerBudgetGate(gate: WorkerBudgetGate): void {
    this.workerBudgetGate = gate;
  }

  assertMayConsume(sessionId: string): void {
    this.workerBudgetGate?.assertMayConsume(sessionId);
  }

  requireRuntime(sessionId: string): RuntimeSession {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) {
      throw new RegistryError("SESSION_NOT_FOUND", `Session ${sessionId} was not found`);
    }
    return runtime;
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()].map(({ record }) => cloneRecord(record));
  }

  /**
   * Worker slots are held by *running* agents only. A finished thread is history: it owns no
   * process, and an `errored` thread owns a process that can no longer do work, so neither may
   * count against the ceiling. This is what lets the fleet view accumulate finished threads
   * without the operator stopping and deleting them to reclaim capacity.
   */
  activeWorkerCount(): number {
    return [...this.sessions.values()].filter(({ record }) =>
      record.executionState === "active" && record.kind !== "orchestrator"
    ).length;
  }

  resolveAncestry(parentSessionId: string | undefined): SessionAncestryEntry[] {
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

  sessionTree(sessionId: string): RuntimeSession[] {
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

  treeProgress(sessionId: string): SessionTreeProgress {
    return progressForTree(this.sessionTree(sessionId));
  }

  requireAdapter(provider: string): ProviderAdapter {
    const adapter = this.options.adapters[provider];
    if (adapter === undefined) {
      throw new RegistryError(
        "PROVIDER_NOT_REGISTERED",
        `Provider ${provider} is not registered for interactive sessions`,
      );
    }
    return adapter;
  }

  /**
   * Provider launch artifacts belong to the prepared launch until a live runtime takes them over, so
   * any failure before that hand-off has to remove them itself — nothing downstream will.
   */
  /**
   * The replay window this session runtime keeps.
   *
   * Read twice: the handle is bounded by it, and the digest ages its window title against it. Those
   * two have to be the same number — a title the replay has already forgotten must stop deciding the
   * session's activity, and a title the replay still holds must keep deciding it.
   */
  replayBytesFor(record: SessionRecord): number {
    return record.profile === "scout"
      ? Math.max(this.options.config.replayBytes, MIN_SCOUT_REPLAY_BYTES)
      : this.options.config.replayBytes;
  }

  async setAttention(
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

  async persist(runtime: RuntimeSession): Promise<void> {
    await this.options.store?.put(cloneRecord(runtime.record));
  }

  async appendTranscript(
    sessionId: string,
    kind: "prompt" | "output" | "instruction" | "lifecycle",
    source: "human" | "provider" | "orchestrator" | "worker" | "broker",
    text: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.options.transcripts?.append({ sessionId, kind, source, text, data });
  }

  async appendEvent(
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

  /**
   * Rehydrate every recovered Scout's result from its drop box.
   *
   * Runs once at startup, after records are recovered and before `ready()` resolves, so a Scout that
   * finished while the broker was down is a finished thread by the time anything can read it.
   */
  async recoverScoutReports(): Promise<void> {
    for (const runtime of this.sessions.values()) {
      await runtime.scout?.recover();
    }
  }
}
