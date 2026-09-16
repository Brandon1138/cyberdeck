import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../../src/domain/session.js";
import { ContainerNativeSource } from "../../../src/runtime/activity/container-native-source.js";
import * as lines from "../../../src/runtime/activity/native-source-lines.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const timestamp = "2026-09-16T10:00:00.000Z";
const frame = (type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload }) + "\n";
const turn = (id: string) => frame("turn_context", { turn_id: id, model: `model-${id}`, effort: "high" })
  + frame("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer-${id}` }] })
  + frame("event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 123 } },
    rate_limits: { primary: { used_percent: 12 }, secondary: { used_percent: 34 } } })
  + frame("event_msg", { type: "task_complete", turn_id: id, last_agent_message: `answer-${id}` });
async function fixture(provider = "codex") {
  const root = await mkdtemp(join(tmpdir(), "native-projection-")); roots.push(root);
  const source = new ContainerNativeSource(root);
  const session: SessionRecord = { id: randomUUID(), provider, cwd: "/workspace", detached: true,
    sandbox: "workspace-write", createdAt: timestamp, updatedAt: timestamp, executionState: "active",
    attachmentState: "detached", pid: 0, exitCode: null, childIds: [], generation: 1, executor: "orbstack-container" };
  const path = provider === "codex" ? join(source.stateRoot(session.id), ".codex", "sessions", "fixture.jsonl")
    : join(source.stateRoot(session.id), ".claude", "projects", "-workspace", `${session.id}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  const prefix = provider === "codex" ? frame("session_meta", { id: randomUUID(), originator: "codex-tui", cwd: "/workspace" }) : "";
  await writeFile(path, prefix);
  return { root, source, session, path, prefix };
}

it("shares exact turn, preview, model and both budget projections, parsing only appended complete frames", async () => {
  const f = await fixture();
  await appendFile(f.path, turn("one"));
  const spy = vi.spyOn(lines, "nativeSourceLinesFromFile");
  const first = await f.source.read(f.session);
  const end = Buffer.byteLength(f.prefix + turn("one"));
  expect(first.turns).toHaveLength(1);
  expect(first.model?.model).toBe("model-one");
  expect(first.budget.providerUsage?.usedPercent).toBe(12);
  expect((await f.source.read(f.session, "weekly")).budget.providerUsage?.usedPercent).toBe(34);
  expect(spy.mock.calls.at(-1)?.[1]).toBe(end);
  // Returned receipts and previews are independent of cache ownership.
  first.turns[0]!.text = "poison";
  first.messages.length = 0;
  const next = turn("two");
  await appendFile(f.path, next.slice(0, 19));
  expect((await f.source.read(f.session)).turns[0]?.text).toBe("answer-one");
  await appendFile(f.path, next.slice(19));
  const actual = await f.source.read(f.session);
  expect(spy.mock.calls.at(-1)?.[1]).toBe(end);
  expect(actual).toEqual(await new ContainerNativeSource(f.root).read(f.session));
  expect(actual.turns.map((receipt) => receipt.providerTurnId)).toEqual(["one", "two"]);
});

it("resets on same-size rewrite, inode replacement, truncation and generation changes", async () => {
  const f = await fixture();
  await appendFile(f.path, turn("one"));
  await f.source.read(f.session);
  await writeFile(f.path, f.prefix + turn("two"));
  expect((await f.source.read(f.session)).turns.map((t) => t.providerTurnId)).toEqual(["two"]);
  await writeFile(`${f.path}.new`, f.prefix + turn("six"));
  await rename(`${f.path}.new`, f.path);
  expect((await f.source.read(f.session)).model?.model).toBe("model-six");
  await writeFile(f.path, f.prefix);
  expect((await f.source.read(f.session)).turns).toEqual([]);
  await appendFile(f.path, turn("one"));
  await f.source.read(f.session);
  f.session.generation = 2;
  const result = await f.source.read(f.session);
  expect(result).toEqual(await new ContainerNativeSource(f.root).read(f.session));
  expect(result.turns[0]?.data).toMatchObject({ nativeActivity: { generation: 2 } });
});

it("rejects changed Codex prefixes and symlink replacements even with a warm cache", async () => {
  const f = await fixture();
  await appendFile(f.path, turn("one"));
  await f.source.read(f.session);
  const outside = join(f.root, "foreign.jsonl");
  await rename(f.path, outside);
  await symlink(outside, f.path);
  await expect(f.source.read(f.session)).rejects.toThrow();
  await rm(f.path);
  await writeFile(f.path, f.prefix.replace("codex-tui", "wrong-tui") + turn("one"));
  await expect(f.source.read(f.session)).rejects.toThrow("NATIVE_BINDING_CONFLICT");
});

it("follows an explicit Claude rebind and refuses /clear after a cached completion", async () => {
  const f = await fixture("claude");
  const final = (id: string) => JSON.stringify({ timestamp, type: "assistant", message: {
    id, model: `model-${id}`, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: id }],
  } }) + "\n";
  await appendFile(f.path, final("one"));
  await f.source.read(f.session);
  const nextId = randomUUID();
  await writeFile(join(dirname(f.path), `${nextId}.jsonl`), final("two"));
  await writeFile(join(f.source.stateRoot(f.session.id), "cyberdeck-native-binding.json"), JSON.stringify({
    nativeSessionId: nextId, relativePath: `.claude/projects/-workspace/${nextId}.jsonl`,
  }));
  expect((await f.source.read(f.session)).turns.map((t) => t.providerTurnId)).toEqual(["two"]);
  await appendFile(join(dirname(f.path), `${nextId}.jsonl`), JSON.stringify({ timestamp, type: "user", message: {
    role: "user", content: "<command-name>/clear</command-name>",
  } }) + "\n");
  await expect(f.source.read(f.session)).rejects.toThrow("NATIVE_CONVERSATION_CLEARED");
  await expect(f.source.read(f.session)).rejects.toThrow("NATIVE_CONVERSATION_CLEARED");
});

it("serializes concurrent projections and rebuilds safely after explicit eviction", async () => {
  const f = await fixture();
  await appendFile(f.path, turn("one"));
  const results = await Promise.all(Array.from({ length: 10 }, () => f.source.read(f.session)));
  expect(results.every((r) => r.turns.length === 1)).toBe(true);
  f.source.forget(f.session.id);
  expect(await f.source.read(f.session)).toEqual(results[0]);
});

it("evicts retained sessions under catalog churn and resets a rewritten growth boundary", async () => {
  const f = await fixture();
  await appendFile(f.path, turn("one"));
  await f.source.read(f.session);
  // A truncate/regrow on the same inode must not splice the old final interval into new bytes.
  await writeFile(f.path, f.prefix + turn("two") + turn("six"));
  expect((await f.source.read(f.session)).turns.map((t) => t.providerTurnId)).toEqual(["two", "six"]);
  for (let i = 0; i < 65; i++) {
    const session = { ...f.session, id: randomUUID() };
    const path = join(f.source.stateRoot(session.id), ".codex", "sessions", "fixture.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, f.prefix + turn("one"));
    await f.source.read(session);
  }
  const spy = vi.spyOn(lines, "nativeSourceLinesFromFile");
  const actual = await f.source.read(f.session);
  expect(spy.mock.calls.at(-1)?.[1]).toBe(0);
  expect(actual).toEqual(await new ContainerNativeSource(f.root).read(f.session));
});

it("detects an earlier-prefix rewrite plus growth even when the last 4096 bytes are unchanged", async () => {
  const f = await fixture();
  const suffix = Array.from({ length: 50 }, (_, i) => turn(`unchanged-${i}`)).join("");
  await appendFile(f.path, turn("one") + suffix);
  await f.source.read(f.session);
  await writeFile(f.path, f.prefix + turn("two") + suffix + turn("new"));
  const actual = await f.source.read(f.session);
  expect(actual.turns[0]?.providerTurnId).toBe("two");
  expect(actual).toEqual(await new ContainerNativeSource(f.root).read(f.session));
});
