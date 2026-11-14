import { assertEvidenceRetainable } from "./strigoi-evidence-deletion.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { STRIGOI_KEY, StrigoiStateSchema, type StrigoiState } from "../domain/strigoi.js";
import type { StrigoiRepository } from "../orchestration/strigoi-ports.js";
import { syncPrivateFile, writeAtomicPrivateFile } from "./atomic-private-file.js";
import { projectBindings, withBindingAuthority } from "./binding-authority.js";
import { openPrivateAppendFile } from "./private-files.js";

export class StrigoiStoreError extends Error {
  constructor(readonly code: "STRIGOI_CORRUPT_STATE" | "STRIGOI_REVISION_CONFLICT" | "STRIGOI_MUTATION_CONFLICT" | "STRIGOI_SESSION_CONFLICT" | "STRIGOI_IO_ERROR", message: string, readonly sessionId?: string) { super(message); this.name = "StrigoiStoreError"; }
}
const RecordSchema = z.object({ revision: z.number().int().positive(), mutationId: z.string().min(1), requestHash: z.string().regex(/^[a-f0-9]{64}$/), state: StrigoiStateSchema }).strict();
const initial = (): StrigoiState => ({ schemaVersion: 1, revision: 0, desired: "disabled", incarnation: 0, retainedSessionIds: [], updatedAt: "1970-01-01T00:00:00.000Z" });
function validateAdvance(previous: StrigoiState, next: StrigoiState): void {
  if (next.incarnation < previous.incarnation) throw new Error("Resident incarnation regressed");
  const oldBinding = previous.activeBinding, binding = next.activeBinding;
  if (binding && (!oldBinding || binding.sessionId !== oldBinding.sessionId || binding.resident?.incarnation !== oldBinding.resident?.incarnation)) {
    if (next.desired !== "enabled" || next.incarnation !== previous.incarnation + 1) throw new Error("Invalid resident activation");
    if (previous.incarnation > 0) {
      const transition = next.transition;
      if (!transition || transition.phase !== "committed" || transition.expectedIncarnation !== previous.incarnation
        || transition.predecessor?.incarnation !== previous.incarnation || (oldBinding && transition.predecessor.sessionId !== oldBinding.sessionId)
        || transition.successor?.sessionId !== binding.sessionId || transition.successor.incarnation !== next.incarnation
        || !transition.packet || !next.latestPacket || JSON.stringify(transition.packet) !== JSON.stringify(next.latestPacket)) throw new Error("Incomplete resident cutover");
    }
  }
}
const hash = (expected: number, next: StrigoiState): string => createHash("sha256").update(JSON.stringify({ expected, next })).digest("hex");

/** One broker owns the directory; all instances in that broker share this serialized authority. */
export class StrigoiStore implements StrigoiRepository {
  readonly path: string;
  private readonly legacyPath: string;
  private readonly stateDirectory: string;
  constructor(stateDirectory: string) {
    stateDirectory = resolve(stateDirectory);
    this.stateDirectory = stateDirectory;
    this.path = join(stateDirectory, "orchestration", "strigoi", "records.jsonl");
    this.legacyPath = join(stateDirectory, "orchestration", "bindings.jsonl");
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> { return withBindingAuthority(this.stateDirectory, work); }
  /** Caller must hold withBindingAuthority for this state directory. */
  async readWithinAuthority(): Promise<StrigoiState> { return structuredClone((await this.load()).state); }
  read(): Promise<StrigoiState> { return this.enqueue(async () => structuredClone((await this.load()).state)); }
  retentionPins(): Promise<ReadonlySet<string>> {
    return this.enqueue(async () => {
      return (await this.load()).pins;
    });
  }
  confirmMutation(mutationId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!(await this.load()).mutations.has(mutationId)) throw new StrigoiStoreError("STRIGOI_MUTATION_CONFLICT", "Unknown resident mutation");
      try { await syncPrivateFile(this.path); } catch { throw new StrigoiStoreError("STRIGOI_IO_ERROR", "Resident journal sync failed"); }
    });
  }
  compareAndSwap(expectedRevision: number, mutationId: string, next: StrigoiState): Promise<StrigoiState> {
    return this.enqueue(async () => {
      const parsed = StrigoiStateSchema.parse(next);
      if (!mutationId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || parsed.revision !== expectedRevision + 1) throw new Error("Invalid Strigoi mutation");
      const requestHash = hash(expectedRevision, parsed);
      const loaded = await this.load();
      const previous = loaded.mutations.get(mutationId);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new StrigoiStoreError("STRIGOI_MUTATION_CONFLICT", "Resident mutation ID reused");
        try { await syncPrivateFile(this.path); } catch { throw new StrigoiStoreError("STRIGOI_IO_ERROR", "Resident journal sync failed"); }
        return structuredClone(previous.state);
      }
      if (loaded.state.revision !== expectedRevision) throw new StrigoiStoreError("STRIGOI_REVISION_CONFLICT", "Resident revision changed");
      await assertEvidenceRetainable(this.stateDirectory, [...parsed.retainedSessionIds,
        parsed.activeBinding?.sessionId, parsed.transition?.predecessor?.sessionId, parsed.transition?.successor?.sessionId]
        .filter((id): id is string => id !== undefined && !loaded.pins.has(id)));
      validateAdvance(loaded.state, parsed);
      this.checkCollision(parsed, loaded.ordinary);
      try {
        if (loaded.tail.length > 0) {
          await writeAtomicPrivateFile(`${this.path}.tail-${randomUUID()}`, JSON.stringify({ encoding: "base64", bytes: loaded.tail.toString("base64") }) + "\n");
          await writeAtomicPrivateFile(this.path, loaded.committed);
        }
        const file = await openPrivateAppendFile(this.path);
        try { await file.writeFile(`${JSON.stringify({ revision: parsed.revision, mutationId, requestHash, state: parsed })}\n`); await file.sync(); } finally { await file.close(); }
        await syncPrivateFile(this.path);
      } catch { throw new StrigoiStoreError("STRIGOI_IO_ERROR", "Resident journal write or sync failed"); }
      return structuredClone(parsed);
    });
  }
  private checkCollision(state: StrigoiState, ordinary: Map<string, { sessionId: string }>): void {
    if (state.activeBinding && [...ordinary.values()].some((binding) => binding.sessionId === state.activeBinding?.sessionId)) throw new StrigoiStoreError("STRIGOI_SESSION_CONFLICT", "Resident session conflicts with ordinary binding", state.activeBinding.sessionId);
  }
  private async load() {
    const legacy = await readFile(this.legacyPath, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return ""; throw e; });
    const legacyLines = legacy.split("\n");
    if (!legacy.endsWith("\n")) legacyLines.pop();
    for (const line of legacyLines) {
      try { const value = JSON.parse(line) as { key?: unknown; kind?: unknown }; if (value.key === STRIGOI_KEY || value.kind === "resident") throw new StrigoiStoreError("STRIGOI_CORRUPT_STATE", "Resident record in legacy binding journal"); }
      catch (e) { if (e instanceof StrigoiStoreError) throw e; }
    }
    const ordinary = projectBindings(legacy);
    const content = await readFile(this.path).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return Buffer.alloc(0); throw new StrigoiStoreError("STRIGOI_CORRUPT_STATE", "Resident journal unavailable"); });
    const boundary = content.lastIndexOf(10) + 1;
    const committed = content.subarray(0, boundary).toString("utf8"), tail = content.subarray(boundary);
    let state = initial();
    const mutations = new Map<string, z.infer<typeof RecordSchema>>();
    const pins = new Set<string>();
    try {
      for (const line of committed.split("\n")) {
        if (!line) continue;
        const record = RecordSchema.parse(JSON.parse(line));
        if (record.revision !== state.revision + 1 || record.state.revision !== record.revision || mutations.has(record.mutationId) || hash(state.revision, record.state) !== record.requestHash) throw new Error("Invalid resident journal sequence");
        validateAdvance(state, record.state);
        for (const id of [...record.state.retainedSessionIds, record.state.activeBinding?.sessionId, record.state.transition?.predecessor?.sessionId, record.state.transition?.successor?.sessionId]) if (id) pins.add(id);
        mutations.set(record.mutationId, record); state = record.state;
      }
    } catch { throw new StrigoiStoreError("STRIGOI_CORRUPT_STATE", "Invalid resident journal"); }
    this.checkCollision(state, ordinary);
    return { state, mutations, committed, tail, pins, ordinary };
  }
}
