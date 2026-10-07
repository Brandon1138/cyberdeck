import { join } from "node:path";
import {
  OrchestratorBindingResetSchema,
  OrchestratorBindingSchema,
  type OrchestratorBinding,
} from "../domain/orchestrator.js";
import { ValidatedJournal } from "./validated-journal.js";

/** Append-only latest-binding registry. Rebinding never erases the prior audit trail. */
export class OrchestratorStore {
  readonly path: string;
  private readonly journal: ValidatedJournal<Map<string, OrchestratorBinding>>;

  constructor(stateDirectory: string) {
    this.path = join(stateDirectory, "orchestration", "bindings.jsonl");
    this.journal = new ValidatedJournal(this.path, projectBindings);
  }

  async get(key: string): Promise<OrchestratorBinding | undefined> {
    const bindings = await this.load();
    return structuredClone(bindings.get(key));
  }

  async list(): Promise<OrchestratorBinding[]> {
    return structuredClone([...(await this.load()).values()]);
  }

  async findBySessionId(sessionId: string): Promise<OrchestratorBinding | undefined> {
    const bindings = await this.load();
    return structuredClone([...bindings.values()].find((binding) => binding.sessionId === sessionId));
  }

  async put(binding: OrchestratorBinding): Promise<void> {
    const parsed = OrchestratorBindingSchema.parse(binding);
    await this.append(parsed);
  }

  async reset(key: string, resetAt = new Date().toISOString()): Promise<void> {
    const parsed = OrchestratorBindingResetSchema.parse({ recordType: "reset", key, resetAt });
    await this.append(parsed);
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
      const reset = OrchestratorBindingResetSchema.safeParse(value);
      if (reset.success) {
        latest.delete(reset.data.key);
        continue;
      }
      const binding = OrchestratorBindingSchema.parse(value);
      latest.set(binding.key, binding);
    }
    return latest;
}
