import { join } from "node:path";
import {
  STRIGOI_KEY,
  OrchestratorBindingResetSchema,
  OrchestratorBindingSchema,
  type OrchestratorBinding,
} from "../domain/orchestrator.js";
import { projectBindings, withBindingAuthority } from "./binding-authority.js";
import { StrigoiStore, StrigoiStoreError } from "./strigoi-store.js";
import { ValidatedJournal } from "./validated-journal.js";

/** Append-only latest-binding registry. Rebinding never erases the prior audit trail. */
export class OrchestratorStore {
  readonly path: string;
  readonly strigoi: StrigoiStore;
  private readonly stateDirectory: string;
  private readonly journal: ValidatedJournal<Map<string, OrchestratorBinding>>;

  constructor(stateDirectory: string) {
    this.stateDirectory = stateDirectory;
    this.strigoi = new StrigoiStore(stateDirectory);
    this.path = join(stateDirectory, "orchestration", "bindings.jsonl");
    this.journal = new ValidatedJournal(this.path, projectBindings);
  }

  async get(key: string): Promise<OrchestratorBinding | undefined> {
    return withBindingAuthority(this.stateDirectory, async () => {
      if (key === STRIGOI_KEY) return (await this.strigoi.readWithinAuthority()).activeBinding;
      const binding = (await this.load()).get(key);
      if (binding) await this.residentIfValid(binding.sessionId);
      return structuredClone(binding);
    });
  }

  async list(): Promise<OrchestratorBinding[]> {
    return withBindingAuthority(this.stateDirectory, async () => {
      const bindings = [...(await this.load()).values()];
      try {
        const resident = await this.residentIfValid();
        if (resident) bindings.push(resident);
      } catch (error) {
        if (!(error instanceof StrigoiStoreError) || error.code !== "STRIGOI_SESSION_CONFLICT" || !error.sessionId) throw error;
        return structuredClone(bindings.filter((binding) => binding.sessionId !== error.sessionId));
      }
      return structuredClone(bindings);
    });
  }

  async findBySessionId(sessionId: string): Promise<OrchestratorBinding | undefined> {
    return withBindingAuthority(this.stateDirectory, async () => {
      const ordinary = [...(await this.load()).values()].find((binding) => binding.sessionId === sessionId);
      if (ordinary) { await this.residentIfValid(ordinary.sessionId); return structuredClone(ordinary); }
      const resident = (await this.strigoi.readWithinAuthority()).activeBinding;
      return resident?.sessionId === sessionId ? resident : undefined;
    });
  }

  async put(binding: OrchestratorBinding): Promise<void> {
    const parsed = OrchestratorBindingSchema.parse(binding);
    if (parsed.kind === "resident" || parsed.key === STRIGOI_KEY) throw new Error("Resident binding requires Strigoi CAS");
    await withBindingAuthority(this.stateDirectory, async () => {
      const bindings = await this.load();
      const existing = bindings.get(parsed.key);
      const established = existing?.sessionId === parsed.sessionId
        && [...bindings.values()].filter((binding) => binding.sessionId === parsed.sessionId).length === 1;
      const resident = established
        ? await this.residentIfValid(parsed.sessionId)
        : (await this.strigoi.readWithinAuthority()).activeBinding;
      if (resident?.sessionId === parsed.sessionId) throw new StrigoiStoreError("STRIGOI_SESSION_CONFLICT", "Resident session conflicts with ordinary binding", parsed.sessionId);
      await this.journal.append(parsed);
    });
  }

  async reset(key: string, resetAt = new Date().toISOString()): Promise<void> {
    if (key === STRIGOI_KEY) throw new Error("Resident binding requires Strigoi CAS");
    const parsed = OrchestratorBindingResetSchema.parse({ recordType: "reset", key, resetAt });
    await withBindingAuthority(this.stateDirectory, () => this.journal.append(parsed));
  }

  private async residentIfValid(unrelatedSessionId?: string): Promise<OrchestratorBinding | undefined> {
    try { return (await this.strigoi.readWithinAuthority()).activeBinding; }
    catch (error) { if (error instanceof StrigoiStoreError && (error.code === "STRIGOI_CORRUPT_STATE" || (error.code === "STRIGOI_SESSION_CONFLICT" && unrelatedSessionId !== undefined && error.sessionId !== unrelatedSessionId))) return undefined; throw error; }
  }

  private load(): Promise<Map<string, OrchestratorBinding>> { return this.journal.read(); }
}
