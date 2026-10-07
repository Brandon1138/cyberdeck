import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";

it("indexes new appends, ignores incomplete tails and follows every retained segment after rotation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-segment-index-")), sessionId = randomUUID();
  try {
    const store = new ThreadTranscriptStore(directory, { maxBytes: 1024, retainedFiles: 2 });
    const events = [];
    for (let index = 0; index < 8; index++) {
      events.push(await store.append({ sessionId, kind: "prompt", source: "human", text: "x".repeat(200) }));
      // Force an index before the next append/rotation rather than testing startup alone.
      expect((await store.read(sessionId, events[index]!.cursor - 1, 1)).events).toEqual([events[index]]);
    }
    const retained = await store.read(sessionId);
    expect(retained.events.length).toBeLessThan(events.length);
    expect(retained.events.at(-1)).toEqual(events.at(-1));
    expect(retained.events.map((event) => event.cursor)).toEqual([...retained.events.map((event) => event.cursor)].sort((a, b) => a - b));
    const partial = { ...events.at(-1)!, id: randomUUID(), cursor: 9, text: "complete JSON without newline" };
    await appendFile(store.path, JSON.stringify(partial));
    expect((await store.read(sessionId, 8)).events).toEqual([]);
    await appendFile(store.path, "\n");
    expect((await store.read(sessionId, 8)).events).toEqual([partial]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
