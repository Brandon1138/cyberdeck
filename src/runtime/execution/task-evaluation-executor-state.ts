import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { TaskEvaluationIntentSchema, TaskEvaluationResultSchema } from "../../domain/task-evaluation.js";
import { ResourceRequestSchema } from "../../domain/resource-budget.js";
import { writeAtomicPrivateFile } from "../../persistence/atomic-private-file.js";

export const INPUT_CAP = 256 * 1024, REPORT_CAP = 768 * 1024;
export const EvaluatorStateSchema = z.object({
  version: z.literal(1), runId: z.uuid(), image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  claim: z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), token: z.uuid(), expiresAt: z.number(), intent: TaskEvaluationIntentSchema, manifest: z.unknown() }),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/), requiredChecks: z.array(z.string().regex(/^[a-z0-9-]{1,128}$/)).max(100),
  resource: ResourceRequestSchema, reservationId: z.string().optional(), backendId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  phase: z.enum(["waiting", "launching", "running", "cleanup", "retained"]),
  result: TaskEvaluationResultSchema.optional(), cleanupConfirmed: z.boolean(), released: z.boolean(), settled: z.boolean(),
  reclaimable: z.boolean().optional(),
  exit: z.object({ exitCode: z.number(), oomKilled: z.boolean() }).optional(),
});
export type EvaluatorState = z.infer<typeof EvaluatorStateSchema>;
export const bytesHash = (text: string) => createHash("sha256").update(text).digest("hex");
function canonical(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)])) : value;
}
export const evaluatorHash = (value: unknown) => bytesHash(JSON.stringify(canonical(value)));
export const evaluatorName = (state: EvaluatorState) => `cyberdeck-evaluator-${state.runId}`;
export const evaluatorLabels = (state: EvaluatorState) => ({ "cyberdeck.installation": state.resource.owner.installationId,
  "cyberdeck.evaluator": state.runId, "cyberdeck.evaluation": state.claim.key, "cyberdeck.input": state.inputHash });
export class EvaluatorFiles {
  constructor(readonly directory: string, readonly capBytes = 32 * 1024 ** 2) {
    if (!Number.isSafeInteger(capBytes) || capBytes < 4 * 1024 ** 2) throw new Error("EVALUATOR_RETENTION_CONFIG_INVALID");
  }
  path(run: string, file: "state.json" | "input.json" | "report.json"): string { z.uuid().parse(run); return join(this.directory, run, file); }
  async read(path: string, cap: number): Promise<string> {
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await fd.stat(); if (!stat.isFile() || stat.size > cap) throw new Error("EVALUATOR_FILE_INVALID"); return await fd.readFile("utf8"); }
    finally { await fd.close(); }
  }
  save(state: EvaluatorState): Promise<void> { return writeAtomicPrivateFile(this.path(state.runId, "state.json"), JSON.stringify(state)); }
  async input(run: string, body: string): Promise<void> {
    if (Buffer.byteLength(body) > INPUT_CAP) throw new Error("EVALUATOR_INPUT_CAP");
    await writeAtomicPrivateFile(this.path(run, "input.json"), body);
    // Parent remains 0700; only this exact, credential-free file is exposed read-only to the guest.
    await chmod(this.path(run, "input.json"), 0o444);
  }
  async inventory(): Promise<Array<{ state: EvaluatorState; bytes: number }>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink()) throw new Error("EVALUATOR_DIRECTORY_INVALID");
    const directories = await readdir(this.directory, { withFileTypes: true });
    if (directories.length > 128) throw new Error("EVALUATOR_RETENTION_CAP");
    const result: Array<{ state: EvaluatorState; bytes: number }> = [];
    for (const entry of directories) {
      if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) throw new Error("EVALUATOR_DIRECTORY_INVALID");
      let bytes = 0;
      for (const file of await readdir(join(this.directory, entry.name), { withFileTypes: true })) {
        if (!file.isFile() || !["state.json", "input.json", "report.json"].includes(file.name)) throw new Error("EVALUATOR_DIRECTORY_INVALID");
        bytes += (await lstat(join(this.directory, entry.name, file.name))).size;
      }
      const state = EvaluatorStateSchema.parse(JSON.parse(await this.read(this.path(entry.name, "state.json"), INPUT_CAP * 2)));
      if (state.runId !== entry.name) throw new Error("EVALUATOR_STATE_MISMATCH");
      result.push({ state, bytes });
    }
    return result;
  }
  async reserveDisk(confirmAbsent: (state: EvaluatorState) => Promise<boolean>): Promise<void> {
    const entries = await this.inventory(); let bytes = entries.reduce((n, e) => n + e.bytes, 0), count = entries.length;
    for (const entry of entries) {
      if (bytes + INPUT_CAP * 3 + REPORT_CAP <= this.capBytes && count < 128) break;
      if (!entry.state.cleanupConfirmed || !entry.state.released || !entry.state.settled) continue;
      if (!await confirmAbsent(entry.state)) throw new Error("EVALUATOR_RETIRED_CONTAINER_PRESENT");
      await rm(join(this.directory, entry.state.runId), { recursive: true }); bytes -= entry.bytes; count--;
    }
    if (bytes + INPUT_CAP * 3 + REPORT_CAP > this.capBytes || count >= 128) throw new Error("EVALUATOR_RETENTION_CAP");
  }
}
