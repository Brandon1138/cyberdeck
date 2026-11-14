import { realpath } from "node:fs/promises";
import { withBindingAuthority } from "./binding-authority.js";

// A reservation fences acquisition without holding binding authority while transcript queues drain.
// Successful deletions remain fenced for this broker lifetime, including late capture callbacks.
export type EvidenceReferenceGuard = <T>(ids: readonly string[], commit: () => Promise<T>) => Promise<T>;
export function withEvidenceReferences<T>(directory: string, ids: readonly string[], commit: () => Promise<T>): Promise<T> {
  return withBindingAuthority(directory, async () => { await assertEvidenceRetainable(directory, ids); return commit(); });
}
const reservations = new Map<string, Set<string>>();
export async function assertEvidenceRetainable(directory: string, ids: readonly string[]): Promise<void> {
  const blocked = reservations.get(await realpath(directory));
  if (ids.some((id) => blocked?.has(id))) throw new Error("STRIGOI_EVIDENCE_DELETING");
}
export async function withEvidenceDeletion<T>(directory: string, id: string,
  check: () => Promise<void>, commit: () => Promise<T>): Promise<T> {
  const key = await realpath(directory);
  await withBindingAuthority(directory, async () => {
    await assertEvidenceRetainable(directory, [id]);
    await check();
    const blocked = reservations.get(key) ?? new Set<string>();
    blocked.add(id); reservations.set(key, blocked);
  });
  try { return await commit(); }
  catch (error) {
    await withBindingAuthority(directory, async () => { reservations.get(key)?.delete(id); });
    throw error;
  }
}
