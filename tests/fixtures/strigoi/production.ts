import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { vi } from "vitest";
import { successionFixture } from "../../orchestration/strigoi-succession-fixture.js";
import { composeGateServices } from "../../../scripts/strigoi-gate-services.js";
import { composeStrigoiEvidence } from "../../../src/persistence/strigoi-evidence-runtime.js";
import { orchestratorController } from "../../../src/domain/orchestrator.js";

/** Real stores, registry, native receipt parser, queues, custody, attention and driver.
 * Only OS execution and provider semantic output are scripted. No lifecycle decisions here. */
export async function productionFixture() {
  const f = await successionFixture(true); f.runtime.dispose();
  let evidence = f.evidence;
  let services = await composeGateServices({ root: f.root, registry: f.registry, transcripts: f.transcripts, evidence, activity: f.activity });
  const effects: { id: string; sessionId: string; text: string; kind?: string }[] = [];
  const respond = async (sessionId: string, text: string, target: number) => {
    const turns = f.nativeResults.get(sessionId) ?? [];
    turns.push({ providerTurnId: randomUUID(), providerOccurredAt: new Date().toISOString(), text, transport: "provider-native" });
    f.nativeResults.set(sessionId, turns);
    const result = await f.registry.waitForWorkerResults([{ sessionId, completionTarget: target }], 5000);
    if (result.timedOut) throw new Error("Fixture native completion was not observed");
  };
  const submit = f.registry.submitInstruction.bind(f.registry);
  const submitSpy = vi.spyOn(f.registry, "submitInstruction").mockImplementation(async (...args) => {
    const result = await submit(...args);
    if (result.state !== "rendered") return result;
    effects.push({ id: args[4]!, sessionId: args[0], text: args[1], ...(typeof args[3]?.successionKind === "string" ? { kind: args[3].successionKind } : {}) });
    if (args[3]?.successionKind) {
      let path: string | undefined = JSON.parse(args[1].match(/page at ("[^"\n]+")./)![1]!);
      const handled: string[] = [];
      while (path) {
        const page = JSON.parse(await readFile(path, "utf8"));
        if (page.sources.length > 64 || Buffer.byteLength(page.sources.map((s: { text: string }) => s.text).join("")) > 32768) throw new Error("Unbounded evidence page");
        handled.push(...page.sources.map((s: { coverageSourceId: string }) => s.coverageSourceId)); path = page.nextPath;
      }
      const state = await evidence.orchestratorStore.strigoi.read();
      await respond(args[0], JSON.stringify(args[3].successionKind === "checkpoint" ? { checkpoint: "Preserve original constraint: review only; no publication because approval is outstanding." }
        : { identity: state.transition!.successor, packetHash: state.transition!.packet!.sha256,
          coverageId: state.transition!.packet!.coverageId, handledSourceIds: handled, account: "Synthetic receipt, not a semantic score; evidence inspected." }), result.expectedTurn!);
    }
    return result;
  });
  const start = async () => { vi.spyOn(services.runtime.lifecycle, "wakeSuccession").mockImplementation(() => {}); await services.start(); await services.runtime.lifecycle.reconcile(); };
  await start();
  await evidence.sources.record("turn", "old-original", { occurredAt: "2020-01-01T00:00:00.000Z", text: "ORIGINAL_RATIONALE: publication awaits independent evidence approval" }, [f.original.activeBinding!.sessionId]);
  const seed = await services.runtime.delivery.submit("Alfred: review only, no publication; approval is outstanding.", randomUUID());
  await respond(seed.targetSessionId, "Original constraint retained", 1); await services.instructions.flush(seed.targetSessionId);
  const owner = f.original.activeBinding!, controller = orchestratorController(owner);
  const worker = await f.registry.start({ provider: "codex", cwd: f.root, detached: true, sandbox: "workspace-write" });
  const registered = await services.coordination.registerSubject({ mutationId: randomUUID(), actor: controller, subjectId: worker.id, controller,
    lifecycle: "working", reason: "Synthetic entrusted work", origin: { creatorControllerId: controller.controllerId,
      creatorSessionId: owner.sessionId, taskId: worker.id, threadId: worker.id, createdAt: worker.createdAt },
    resources: { sessionId: worker.id, worktreePath: f.root, eventStreamId: worker.id } });
  const lease = registered.outcomes[0]!;
  services.credentials.set(controller.controllerId, worker.id, { leaseVersion: lease.leaseVersion!, leaseToken: lease.leaseToken! });
  await f.registry.attach(worker.id, "fixture-operator", "control", () => {});
  const outgoing = await services.instructions.enqueue({ actorSessionId: owner.sessionId, targetSessionId: worker.id, message: "Continue entrusted review only" });
  await services.attention.arm({ actorSessionId: owner.sessionId, mutationId: randomUUID(), objective: "Review entrusted result", nextAction: "Inspect exact evidence", targets: [{ sessionId: worker.id, completionTarget: 1 }] });
  return { f, effects, respond, seed, worker, outgoing, controller, submitSpy,
    get services() { return services; }, get evidence() { return evidence; },
    async reopen() {
      await services.close();
      // Reopen every durable participant. Keep known owned fixture OS processes; this is a
      // service/journal restart, not a claim that a real process survives broker death.
      const custody = services.credentials.get(controller.controllerId, worker.id);
      evidence = composeStrigoiEvidence(f.root); await evidence.startup(f.transcripts, f.sessions);
      services = await composeGateServices({ root: f.root, registry: f.registry, transcripts: f.transcripts, evidence, activity: f.activity });
      if (custody) services.credentials.set(controller.controllerId, worker.id, custody);
      await start();
    },
    async drive(id: string) {
      for (let i = 0; i < 8; i++) {
        const state = (await services.runtime.succession!.advance(id)).state;
        if (state.hold || ["complete", "aborted"].includes(state.transition?.phase ?? "")) return state;
      }
      return evidence.orchestratorStore.strigoi.read();
    },
    async close() {
      await services.close(); submitSpy.mockRestore(); await f.close();
      if (vi.mocked(f.turns.submit).mock.calls.length || f.workers.reconcile.mock.calls.length || f.delivery.reconcile.mock.calls.length)
        throw new Error("Prototype participant was invoked by production acceptance");
    },
  };
}
