import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { InstructionStore } from "../../src/persistence/instruction-store.js";
import { withBindingAuthority } from "../../src/persistence/binding-authority.js";
import { withEvidenceReferences } from "../../src/persistence/strigoi-evidence-deletion.js";
import { OrchestratorAttentionStore } from "../../src/persistence/orchestrator-attention-store.js";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { attentionHarness, cleanupAttentionHarnesses } from "../support/attention-harness.js";
import { deferred, fixture, actor } from "../orchestration/strigoi-admission-fixture.js";

const roots: string[] = [];
afterEach(async () => { await cleanupAttentionHarnesses(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "strigoi-lock-order-")); roots.push(path); return path; }
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("authority/store cycle")), 1000); })]); }
  finally { clearTimeout(timer!); }
}

it.each(["instruction", "transcript"] as const)("activation can write %s while an unrelated writer waits for authority", async (kind) => {
  const directory = await root(), f = fixture(), entered = deferred(), startOwnerWrite = deferred(), abandon = deferred();
  const guard = <T>(ids: readonly string[], commit: () => Promise<T>) => withEvidenceReferences(directory, ids, commit);
  const store = kind === "instruction" ? new InstructionStore(directory, undefined, guard)
    : new ThreadTranscriptStore(directory, { continuity: { event: async event => { await guard([event.sessionId], async () => {}); }, beforeDelete: async () => {}, native: async () => {} } });
  const put = (id: string) => store instanceof InstructionStore ? store.put({ ...f.record, id })
    : store.append({ sessionId: actor, kind: "prompt", source: "human", text: id });
  let pendingOwner: Promise<unknown> | undefined;
  const owner = withBindingAuthority(directory, async () => {
    entered.resolve(); await startOwnerWrite.promise;
    pendingOwner = put("11111111-1111-4111-8111-111111111111");
    await Promise.race([pendingOwner, abandon.promise]);
  });
  await entered.promise;
  const unrelated = put("22222222-2222-4222-8222-222222222222");
  try {
    startOwnerWrite.resolve(); await bounded(Promise.all([owner, unrelated]));
  } finally { startOwnerWrite.resolve(); abandon.resolve(); await Promise.allSettled([owner, unrelated, pendingOwner]); }
});

it("activation get/update do not wait behind an attention preparation waiting for authority", async () => {
  const f = await attentionHarness(); const armed = await f.attention.arm(f.request()); f.attention.stop(); await f.attention.flush();
  const guard = <T>(ids: readonly string[], commit: () => Promise<T>) => withEvidenceReferences(f.directory, ids, commit);
  const store = new OrchestratorAttentionStore(f.directory, undefined, undefined, guard);
  const preparing = deferred(), releasePreparation = deferred(), ownerEntered = deferred(), read = deferred();
  const update = store.update(armed.controllerId, async current => {
    preparing.resolve(); await releasePreparation.promise; return { ...current!, updatedAt: "2026-11-15T00:00:00.000Z" };
  });
  await preparing.promise;
  const owner = withBindingAuthority(f.directory, async () => {
    ownerEntered.resolve(); await read.promise;
    await bounded(store.get(armed.controllerId));
    await bounded(store.update(armed.controllerId, async current => ({ ...current!, status: "cancelled", cancelReason: "Activation", cancelledAt: armed.updatedAt })));
  });
  await ownerEntered.promise; releasePreparation.resolve(); read.resolve();
  try { await owner; } finally { releasePreparation.resolve(); await Promise.allSettled([owner, update]); }
  expect(await store.get(armed.controllerId)).toMatchObject({ status: "cancelled" });
});
