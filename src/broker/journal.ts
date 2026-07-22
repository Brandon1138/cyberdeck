import { join } from "node:path";
import { BrokerEventSchema, type BrokerEvent } from "../domain/events.js";
import { openPrivateAppendFile } from "../persistence/private-files.js";

export class Journal {
  readonly path: string;

  constructor(private readonly stateDirectory: string) {
    this.path = join(stateDirectory, "events.jsonl");
  }

  async append(event: BrokerEvent): Promise<void> {
    const validated = BrokerEventSchema.parse(event);
    const handle = await openPrivateAppendFile(this.path);
    try {
      await handle.write(`${JSON.stringify(validated)}\n`);
    } finally {
      await handle.close();
    }
  }
}
