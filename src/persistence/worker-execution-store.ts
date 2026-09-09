import { randomUUID } from "node:crypto";
import { readFile, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ExecutionRecordSchema, type ExecutionRecord } from "../domain/worker-execution.js";
import type { ExecutionStorePort } from "../orchestration/session/execution-ports.js";
import { ensurePrivateDirectory, openPrivateAppendFile } from "./private-files.js";

/** Host-only journal. A complete malformed frame fails closed; an uncommitted tail is preserved. */
export class WorkerExecutionStore implements ExecutionStorePort {
  brokerId = "";
  private records = new Map<string, ExecutionRecord>();
  private tail: Promise<void> = Promise.resolve();
  private poisoned = false;
  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<WorkerExecutionStore> {
    const store = new WorkerExecutionStore(directory);
    await ensurePrivateDirectory(directory);
    const identityPath = join(directory, "execution-broker-id");
    try {
      const handle = await open(identityPath, "wx", 0o600);
      try { await handle.writeFile(randomUUID()); await handle.sync(); } finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    store.brokerId = z.uuid().parse(await readFile(identityPath, "utf8"));
    let data = "";
    try { data = await readFile(store.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const boundary = data.lastIndexOf("\n") + 1;
    if (boundary < data.length) {
      const evidence = await open(join(directory, `execution-torn-tail-${randomUUID()}.txt`), "wx", 0o600);
      try { await evidence.writeFile(data.slice(boundary)); await evidence.sync(); } finally { await evidence.close(); }
      const journal = await open(store.path, "r+");
      try { await journal.truncate(Buffer.byteLength(data.slice(0, boundary))); await journal.sync(); }
      finally { await journal.close(); }
    }
    for (const line of data.slice(0, boundary).split("\n").filter(Boolean)) {
      const record = ExecutionRecordSchema.parse(JSON.parse(line));
      store.validate(record);
      store.records.set(record.ref.sessionId, record);
    }
    return store;
  }
  private get path(): string { return join(this.directory, "worker-executions.jsonl"); }
  get(sessionId: string): ExecutionRecord | undefined {
    const record = this.records.get(sessionId);
    return record === undefined ? undefined : structuredClone(record);
  }
  list(): ExecutionRecord[] { return [...this.records.values()].map((record) => structuredClone(record)); }
  private validate(record: ExecutionRecord): void {
    if (record.ref.brokerId !== this.brokerId) throw new Error("EXECUTION_BROKER_MISMATCH");
    const prior = this.records.get(record.ref.sessionId);
    if (prior !== undefined && (prior.ref.executionId !== record.ref.executionId
      || prior.ref.workerId !== record.ref.workerId || prior.ref.executor !== record.ref.executor
      || prior.request.profile !== record.request.profile || prior.ref.generation > record.ref.generation)) {
      throw new Error("EXECUTION_BINDING_CONFLICT");
    }
    if (record.request.executor !== record.ref.executor) throw new Error("EXECUTION_BINDING_CONFLICT");
  }
  put(input: ExecutionRecord): Promise<void> {
    const record = ExecutionRecordSchema.parse(input);
    const operation = this.tail.then(async () => {
      if (this.poisoned) throw new Error("EXECUTION_STORE_UNCERTAIN");
      this.validate(record);
      const handle = await openPrivateAppendFile(this.path);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`);
        await handle.sync();
        this.records.set(record.ref.sessionId, record);
      } catch (error) { this.poisoned = true; throw error; }
      finally { await handle.close(); }
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
}
