import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { ThreadEvent, ThreadPageOptions } from "../../src/domain/thread.js";
import { readThreadPage } from "../../src/orchestration/thread-read-page.js";

const sessionId = randomUUID();
const event = (cursor: number, text: string): ThreadEvent => ({ id: randomUUID(), sessionId, cursor,
  occurredAt: "2026-10-07T00:00:00.000Z", kind: "turn", source: "provider", text,
  data: { nested: { detail: '"\\\n🧑‍💻'.repeat(800) }, ordinal: cursor } });

it("bounds serialized pages and reconstructs every text/data byte without advancing past partial events", async () => {
  const original = event(1, '漢字 e\u0301 👨‍👩‍👧‍👦 "quoted"\n'.repeat(500));
  const events = [original, { ...event(2, "next event"), data: {} }];
  const transcripts = { read: async (_session: string, after = 0, limit = 1) => {
    const page = events.filter((value) => value.cursor > after).slice(0, limit);
    return { events: page, nextCursor: page.at(-1)?.cursor ?? after };
  } };
  let after = 0, options: ThreadPageOptions = { maxBytes: 1024 }, json = "", pages = 0;
  do {
    const page = await readThreadPage(transcripts, sessionId, after, 10, options);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024);
    expect(page.fragment?.byteOffset).toBe(Buffer.byteLength(json));
    json += page.fragment!.json; pages++;
    if (page.continuation !== undefined) {
      expect(page.nextCursor).toBe(0);
      expect(await readThreadPage(transcripts, sessionId, after, 10, options)).toEqual(page);
    }
    after = page.nextCursor;
    options = { maxBytes: 1024, ...(page.continuation === undefined ? {} : { continuation: page.continuation }) };
  } while (options.continuation !== undefined);
  expect(pages).toBeGreaterThan(2);
  expect(JSON.parse(json)).toEqual(original);
  expect(after).toBe(1);
  expect((await readThreadPage(transcripts, sessionId, after, 10, options)).events).toEqual([events[1]]);
});

it("refuses a continuation when unread content changes or retention rotates it away", async () => {
  let current = event(1, "oversized".repeat(2000));
  const transcripts = { read: async () => ({ events: [current], nextCursor: current.cursor }) };
  const page = await readThreadPage(transcripts, sessionId, 0, 1, { maxBytes: 1024 });
  current = { ...current, text: "changed".repeat(2000) };
  await expect(readThreadPage(transcripts, sessionId, 0, 1, { maxBytes: 1024, continuation: page.continuation }))
    .rejects.toMatchObject({ code: "STALE_THREAD_DETAIL" });
  current = event(2, "successor");
  await expect(readThreadPage(transcripts, sessionId, 0, 1, { maxBytes: 1024, continuation: page.continuation }))
    .rejects.toMatchObject({ code: "STALE_THREAD_DETAIL" });
});
