import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { OrchestratorBindingResetSchema, OrchestratorBindingSchema, STRIGOI_KEY, type OrchestratorBinding } from "../domain/orchestrator.js";

const queues = new Map<string, Promise<void>>();
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), basename(path));
  }
}
/** Shared by every resident and ordinary binding write in the broker singleton. */
export async function withBindingAuthority<T>(stateDirectory: string, work: () => Promise<T>): Promise<T> {
  const key = await canonical(resolve(stateDirectory));
  const operation = (queues.get(key) ?? Promise.resolve()).then(work);
  const tail = operation.then(() => {}, () => {});
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return operation;
}
export function projectBindings(content: string): Map<string, OrchestratorBinding> {
  const latest = new Map<string, OrchestratorBinding>(), lines = content.split("\n");
  if (!content.endsWith("\n")) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const value: unknown = JSON.parse(line);
    if (typeof value === "object" && value !== null && ("key" in value && value.key === STRIGOI_KEY || "kind" in value && value.kind === "resident")) continue;
    const reset = OrchestratorBindingResetSchema.safeParse(value);
    if (reset.success) { latest.delete(reset.data.key); continue; }
    const binding = OrchestratorBindingSchema.parse(value);
    latest.set(binding.key, binding);
  }
  return latest;
}
