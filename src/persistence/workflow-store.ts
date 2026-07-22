import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  WorkflowMessageSchema,
  WorkflowRunSchema,
  type WorkflowMessage,
  type WorkflowRun,
} from "../domain/workflow.js";

export class WorkflowStore {
  private readonly runsPath: string;
  private readonly messagesPath: string;

  constructor(stateDirectory: string) {
    this.runsPath = join(stateDirectory, "orchestration", "workflow-runs.jsonl");
    this.messagesPath = join(stateDirectory, "orchestration", "workflow-messages.jsonl");
  }

  async putRun(run: WorkflowRun): Promise<void> {
    await append(this.runsPath, WorkflowRunSchema.parse(run));
  }

  async listRuns(): Promise<WorkflowRun[]> {
    const records = await readLines(this.runsPath, WorkflowRunSchema.parse);
    const latest = new Map<string, WorkflowRun>();
    for (const record of records) latest.set(record.id, record);
    return [...latest.values()];
  }

  async getRun(runId: string): Promise<WorkflowRun | undefined> {
    return (await this.listRuns()).find((run) => run.id === runId);
  }

  async putMessage(message: WorkflowMessage): Promise<void> {
    await append(this.messagesPath, WorkflowMessageSchema.parse(message));
  }

  async listMessages(runId: string): Promise<WorkflowMessage[]> {
    return (await readLines(this.messagesPath, WorkflowMessageSchema.parse))
      .filter((message) => message.runId === runId);
  }
}

async function append(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.write(`${JSON.stringify(value)}\n`, undefined, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLines<T>(path: string, parse: (value: unknown) => T): Promise<T[]> {
  const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const lines = content.split("\n");
  if (!content.endsWith("\n")) lines.pop();
  return lines.filter((line) => line.trim() !== "").map((line) => parse(JSON.parse(line)));
}

