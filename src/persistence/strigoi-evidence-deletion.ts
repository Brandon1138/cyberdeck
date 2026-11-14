import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { withBindingAuthority } from "./binding-authority.js";
import { syncPrivateFile, writeAtomicPrivateFile } from "./atomic-private-file.js";

const StateSchema = z.object({ schemaVersion: z.literal(1), retainedSessionIds: z.array(z.uuid()),
  deletions: z.array(z.object({ sessionId: z.uuid(), phase: z.enum(["pending", "complete"]) }).strict()),
}).strict();
type SafetyState = z.infer<typeof StateSchema>;
const EnvelopeSchema = z.object({ state: StateSchema, sha256: z.string() }).strict();
const digest = (state: SafetyState) => createHash("sha256").update(JSON.stringify(state)).digest("hex");
const pathFor = (directory: string) => join(directory, "orchestration", "strigoi", "evidence-safety.json");
async function optional(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
}
async function load(directory: string): Promise<SafetyState> {
  const path = pathFor(directory), body = await optional(path);
  if (body === undefined) {
    if (await optional(`${path}.initialized`) !== undefined) throw new Error("STRIGOI_EVIDENCE_SAFETY_MISSING");
    return { schemaVersion: 1, retainedSessionIds: [], deletions: [] };
  }
  try {
    const { state, sha256 } = EnvelopeSchema.parse(JSON.parse(body));
    if (sha256 !== digest(state) || new Set(state.deletions.map((d) => d.sessionId)).size !== state.deletions.length
      || state.deletions.some((d) => state.retainedSessionIds.includes(d.sessionId))) throw new Error("Invalid safety state");
    return state;
  } catch { throw new Error("STRIGOI_EVIDENCE_SAFETY_CORRUPT"); }
}
/** Re-sync even unchanged visible state: an earlier rename may have preceded a failed fsync. */
async function save(directory: string, state: SafetyState): Promise<void> {
  const path = pathFor(directory), body = JSON.stringify({ state, sha256: digest(state) }) + "\n";
  if (await optional(path) === body) await syncPrivateFile(path);
  else await writeAtomicPrivateFile(path, body);
  await writeAtomicPrivateFile(`${path}.initialized`, "1\n");
}
export function evidenceSafety(directory: string): Promise<SafetyState> {
  return withBindingAuthority(directory, () => load(directory));
}
export type EvidenceReferenceGuard = <T>(ids: readonly string[], commit: () => Promise<T>) => Promise<T>;
export function withEvidenceReferences<T>(directory: string, ids: readonly string[], commit: () => Promise<T>): Promise<T> {
  return withBindingAuthority(directory, async () => { await assertEvidenceRetainable(directory, ids); return commit(); });
}
/** Conservative pins precede canonical publication; failures never release them in v1. */
export function retainEvidenceReferences(directory: string, ids: readonly string[]): Promise<void> {
  return withBindingAuthority(directory, async () => {
    await assertEvidenceRetainable(directory, ids);
    const state = await load(directory);
    state.retainedSessionIds = [...new Set([...state.retainedSessionIds, ...ids])].sort();
    await save(directory, state);
  });
}
export async function assertEvidenceRetainable(directory: string, ids: readonly string[]): Promise<void> {
  if ((await load(directory)).deletions.some((d) => ids.includes(d.sessionId))) throw new Error("STRIGOI_EVIDENCE_DELETING");
}
// This set excludes overlapping retries only. Disk, not this set, fences reference acquisition.
const running = new Set<string>();
export async function withEvidenceDeletion<T>(directory: string, id: string,
  check: () => Promise<void>, commit: () => Promise<T>): Promise<T> {
  const key = `${await realpath(directory)}:${id}`;
  await withBindingAuthority(directory, async () => {
    if (running.has(key)) throw new Error("STRIGOI_EVIDENCE_DELETING");
    await check();
    const state = await load(directory);
    if (state.retainedSessionIds.includes(id)) throw new Error("STRIGOI_EVIDENCE_REFERENCED");
    if (!state.deletions.some((d) => d.sessionId === id)) state.deletions.push({ sessionId: id, phase: "pending" });
    await save(directory, state); // Durable intent before the first destructive callback.
    running.add(key);
  });
  try {
    const result = await commit(); // Never hold binding authority while draining other queues.
    await withBindingAuthority(directory, async () => {
      const state = await load(directory);
      state.deletions.find((d) => d.sessionId === id)!.phase = "complete";
      await save(directory, state);
    });
    return result;
  } finally {
    running.delete(key); // Keep the durable intent after any partial/ambiguous destructive failure.
  }
}
/** Startup settles catalog-confirmed deletions, preserving visible interrupted records for retry. */
export function reconcileEvidenceDeletions(directory: string, visible: ReadonlySet<string>,
  confirmCatalog: () => Promise<void>): Promise<Set<string>> {
  return withBindingAuthority(directory, async () => {
    const state = await load(directory);
    const absent = state.deletions.filter((d) => d.phase === "pending" && !visible.has(d.sessionId));
    if (absent.length) {
      await confirmCatalog();
      absent.forEach((d) => { d.phase = "complete"; });
      await save(directory, state);
    }
    return new Set(state.deletions.filter((d) => visible.has(d.sessionId)).map((d) => d.sessionId));
  });
}
