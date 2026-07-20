import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BrokerEventSchema, type BrokerEvent } from "../domain/events.js";

export class Journal {
  readonly path: string;

  constructor(private readonly stateDirectory: string) {
    this.path = join(stateDirectory, "events.jsonl");
  }

  async append(event: BrokerEvent): Promise<void> {
    const validated = BrokerEventSchema.parse(event);
    await mkdir(this.stateDirectory, { recursive: true });
    await appendFile(this.path, `${JSON.stringify(validated)}\n`, "utf8");
  }
}
