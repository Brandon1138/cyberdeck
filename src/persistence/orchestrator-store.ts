import { join } from "node:path";
import {
  STRIGOI_KEY,
  OrchestratorBindingResetSchema,
  OrchestratorBindingSchema,
  type OrchestratorBinding,
} from "../domain/orchestrator.js";
import { StrigoiStore, StrigoiStoreError } from "./strigoi-store.js";
import { ValidatedJournal } from "./validated-journal.js";

/** Append-only latest-binding registry. Rebinding never erases the prior audit trail. */
export class OrchestratorStore {
  readonly path: string;
  readonly strigoi: StrigoiStore;
  private readonly journal: ValidatedJournal<Map<string, OrchestratorBinding>>;

  constructor(stateDirectory: string) {
    this.strigoi = new StrigoiStore(stateDirectory);
    this.path = join(stateDirectory, "orchestration", "bindings.jsonl");
    this.journal = new ValidatedJournal(this.path, projectBindings);
  }

  async get(key: string): Promise<OrchestratorBinding | undefined> {
    if (key === STRIGOI_KEY) return (await this.strigoi.read()).activeBinding;
    const bindings = await this.load();
    return structuredClone(bindings.get(key));
  }

  async list(): Promise<OrchestratorBinding[]> {
    const bindings = [...(await this.load()).values()];
    const resident = await this.residentIfValid();
    if (resident) bindings.push(resident);
    return structuredClone(bindings);
  }

  async findBySessionId(sessionId: string): Promise<OrchestratorBinding | undefined> {
    const bindings = await this.load();
    const ordinary = [...bindings.values()].find((binding) => binding.sessionId === sessionId);
    if (ordinary) return structuredClone(ordinary);
    const resident = await this.residentIfValid();
    return resident?.sessionId === sessionId ? resident : undefined;
  }

  async put(binding: OrchestratorBinding): Promise<void> {
    const parsed = OrchestratorBindingSchema.parse(binding);
    if (parsed.kind === "resident" || parsed.key === STRIGOI_KEY) throw new Error("Resident binding requires Strigoi CAS");
    await this.append(parsed);
  }

  async reset(key: string, resetAt = new Date().toISOString()): Promise<void> {
    if (key === STRIGOI_KEY) throw new Error("Resident binding requires Strigoi CAS");
    const parsed = OrchestratorBindingResetSchema.parse({ recordType: "reset", key, resetAt });
    await this.append(parsed);
  }

  private async residentIfValid(): Promise<OrchestratorBinding | undefined> {
    try { return (await this.strigoi.read()).activeBinding; }
    catch (error) { if (error instanceof StrigoiStoreError && error.code === "STRIGOI_CORRUPT_STATE") return undefined; throw error; }
  }

  private async append(record: OrchestratorBinding | { recordType: "reset"; key: string; resetAt: string }): Promise<void> {
    await this.journal.append(record);
  }

  private load(): Promise<Map<string, OrchestratorBinding>> { return this.journal.read(); }
}

function projectBindings(content: string): Map<string, OrchestratorBinding> {
    const latest = new Map<string, OrchestratorBinding>();
    const lines = content.split("\n");
    if (!content.endsWith("\n")) lines.pop();
    for (const line of lines) {
      if (line.trim() === "") continue;
      const value: unknown = JSON.parse(line);
      if (typeof value === "object" && value !== null && ("key" in value && value.key === STRIGOI_KEY || "kind" in value && value.kind === "resident")) continue;
      const reset = OrchestratorBindingResetSchema.safeParse(value);
      if (reset.success) {
        if (reset.data.key === STRIGOI_KEY) continue;
        latest.delete(reset.data.key);
        continue;
      }
      const binding = OrchestratorBindingSchema.parse(value);
      if (binding.kind !== "resident" && binding.key !== STRIGOI_KEY) latest.set(binding.key, binding);
    }
    return latest;
}
