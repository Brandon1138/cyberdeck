import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  OrchestratorBindingResetSchema,
  OrchestratorBindingSchema,
  type OrchestratorBinding,
} from "../domain/orchestrator.js";

/** Append-only latest-binding registry. Rebinding never erases the prior audit trail. */
export class OrchestratorStore {
  readonly path: string;

  constructor(stateDirectory: string) {
    this.path = join(stateDirectory, "orchestration", "bindings.jsonl");
  }

  async get(key: string): Promise<OrchestratorBinding | undefined> {
    const bindings = await this.load();
    return bindings.get(key);
  }

  async findBySessionId(sessionId: string): Promise<OrchestratorBinding | undefined> {
    const bindings = await this.load();
    return [...bindings.values()].find((binding) => binding.sessionId === sessionId);
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
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.write(`${JSON.stringify(record)}\n`, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async load(): Promise<Map<string, OrchestratorBinding>> {
    const content = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
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
}
