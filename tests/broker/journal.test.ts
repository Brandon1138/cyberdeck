import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Journal } from "../../src/broker/journal.js";
import type { BrokerEvent } from "../../src/domain/events.js";

describe("Journal", () => {
  it("appends independently parseable events in order", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "cyberdeck-journal-"));
    const journal = new Journal(stateDirectory);
    const sessionId = crypto.randomUUID();
    const events: BrokerEvent[] = [
      {
        id: crypto.randomUUID(),
        type: "session.created",
        sessionId,
        occurredAt: new Date().toISOString(),
        data: {},
      },
      {
        id: crypto.randomUUID(),
        type: "session.exited",
        sessionId,
        occurredAt: new Date().toISOString(),
        data: { exitCode: 0 },
      },
    ];

    await journal.append(events[0]!);
    await journal.append(events[1]!);

    const lines = (await readFile(journal.path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual(events);
  });
});
