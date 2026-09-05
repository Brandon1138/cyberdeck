import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, appendFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { AgentActivityStore } from "../../../src/persistence/agent-activity-store.js";
import { NativeActivityCursor } from "../../../src/runtime/activity/native-activity-cursor.js";
import { codexActivity } from "../../../src/runtime/activity/codex-activity.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "activity-cursor-")); roots.push(root);
  const recorder = await AgentActivityStore.open(join(root, "journal"));
  const id = randomUUID(), path = join(root, "native.jsonl"), directory = join(root, "cursors");
  const attribution = { runId: id, workerId: id, sessionId: id, generation: 1, instructionId: randomUUID(), providerTurnId: "turn-1" };
  const input = { path, sourceId: "fixture-source", provider: "codex", parse: codexActivity, attribution, fromOffset: 0 };
  return { recorder, directory, input };
}
const frame = (type: string) => JSON.stringify({ type: "response_item", payload: { type, call_id: "parallel-call-1", arguments: "LOCAL_SECRET" } }) + "\n";
it("does not advance over partial lines, resumes without duplicates, and retains source references only", async () => {
  const f = await fixture(), first = frame("function_call"), second = frame("function_call_output");
  await writeFile(f.input.path, first + second.slice(0, 10));
  const cursor = new NativeActivityCursor(f.directory, f.recorder);
  expect(await cursor.collect({ ...f.input, throughOffset: Buffer.byteLength(first) + 10 })).toBe(1);
  await appendFile(f.input.path, second.slice(10));
  const reopened = new NativeActivityCursor(f.directory, f.recorder);
  expect(await reopened.collect({ ...f.input, throughOffset: Buffer.byteLength(first + second) })).toBe(1);
  expect(await reopened.collect({ ...f.input, throughOffset: Buffer.byteLength(first + second) })).toBe(0);
  const events = await f.recorder.read(f.input.attribution.runId, 0, 100);
  expect(events.map((event) => event.kind)).toEqual(["tool.invocation", "tool.result"]);
  expect(JSON.stringify(events)).not.toContain("LOCAL_SECRET");
});
it("records a visible gap and preserves a source whose acknowledged prefix changes", async () => {
  const f = await fixture(), first = frame("function_call");
  await writeFile(f.input.path, first);
  const cursor = new NativeActivityCursor(f.directory, f.recorder);
  await cursor.collect({ ...f.input, throughOffset: Buffer.byteLength(first) });
  await writeFile(f.input.path, first.replace("parallel", "tampered"));
  await expect(cursor.collect({ ...f.input, throughOffset: Buffer.byteLength(first) })).rejects.toThrow("ACTIVITY_SOURCE_MODIFIED");
  expect((await f.recorder.read(f.input.attribution.runId, 0, 100)).at(-1)).toMatchObject({ kind: "capture.gap", coverage: "partial" });
});
it("never checkpoints provider progress after a failed activity append", async () => {
  const f = await fixture(), text = frame("function_call");
  await writeFile(f.input.path, text);
  const broken = new NativeActivityCursor(f.directory, { read: f.recorder.read.bind(f.recorder), health: f.recorder.health.bind(f.recorder), append: async () => { throw new Error("disk-full"); } });
  await expect(broken.collect({ ...f.input, throughOffset: Buffer.byteLength(text) })).rejects.toThrow("disk-full");
  expect(await readdir(f.directory)).toEqual([]);
  expect(await new NativeActivityCursor(f.directory, f.recorder).collect({ ...f.input, throughOffset: Buffer.byteLength(text) })).toBe(1);
});
