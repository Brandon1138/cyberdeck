import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { brokerFixture, eventually, type EvalMode } from "./broker-fixture.js";
import type { WorkerTurnObservation } from "../../src/orchestration/session/worker-turn-ports.js";
import type { LiveEvalConfig } from "./live-config.js";
import { livePrompts } from "../scenarios/live-prompts.js";

/** Scripted modes control the delayed final frame; that is a scheduling proof. Live mode observes
 * two real turns and asserts their receipts stayed distinct, which is stochastic provider behaviour. */
export async function phantomTurnScenario(root: string, mode: EvalMode = "offline-scripted", live?: LiveEvalConfig) {
  if (mode === "live-container") return livePhantomTurn(root, live!);
  const store = new ThreadTranscriptStore(join(root, "transcripts"));
  let release!: () => void, entered = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const observations: WorkerTurnObservation[] = [];
  const broker = await brokerFixture(root, { mode, transcripts: {
    append: store.append.bind(store),
    observeProviderTurns: async (input) => ({ sessionId: input.sessionId, provider: "claude", turnNumber: input.turnNumber,
      turns: [{ providerTurnId: `fixture-turn-${input.turnNumber}`, providerOccurredAt: new Date().toISOString(),
        text: `answer-${input.turnNumber}`, transport: "provider-native" }] }),
    commitProviderTurns: async (observation) => {
      observations.push(observation);
      const receipts = await store.commitProviderTurns(observation);
      if (observation.turnNumber === 1 && !entered) { entered = true; await gate; }
      return receipts;
    },
  } });
  try {
    const first = await broker.instruct("first turn");
    await eventually(() => entered, "DELAYED_COMMIT_NOT_REACHED", broker.timeout);
    const second = await broker.instruct("second turn");
    const beforeRelease = await broker.queue.list(broker.worker.id);
    const premature = beforeRelease.find((record) => record.id === second.id)?.status === "completed";
    release();
    await eventually(async () => (await broker.queue.list(broker.worker.id)).filter((record) => record.status === "completed").length === 2, "PHANTOM_TURN_COMPLETION_MISSING", broker.timeout);
    const instructions = await broker.queue.list(broker.worker.id);
    const one = instructions.find((record) => record.id === first.id)!, two = instructions.find((record) => record.id === second.id)!;
    const commands = (await readFile(join(broker.cwd, "commands.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    return { brokerId: broker.brokerId, image: broker.container?.image, facts: { instructions, beforeRelease, observations, commands },
      checks: { "distinct-instructions": first.id !== second.id && one.expectedTurn === 1 && two.expectedTurn === 2,
        "late-turn-not-reused": !premature && observations.some((item) => item.turnNumber === 2),
        "second-instruction-completed": two.status === "completed" && commands.filter((item) => item.input === "second turn").length === 1 } };
  } finally { release(); await broker.close(); }
}
async function livePhantomTurn(root: string, live: LiveEvalConfig) {
  const broker = await brokerFixture(root, { mode: "live-container", live });
  try {
    const first = await broker.instruct(livePrompts["phantom-turn"][0]);
    const second = await broker.instruct(livePrompts["phantom-turn"][1]);
    await eventually(async () => (await broker.queue.list(broker.worker.id)).filter((record) => record.status === "completed").length === 2, "LIVE_TURNS_NOT_COMPLETED", broker.timeout);
    const instructions = await broker.queue.list(broker.worker.id);
    const one = instructions.find((record) => record.id === first.id)!, two = instructions.find((record) => record.id === second.id)!;
    const receipts = (await broker.rpc.request<{ events: Array<{ kind: string; data: Record<string, unknown> }> }>("thread.read", { sessionId: broker.worker.id, afterCursor: 0, limit: 1000 })).events
      .filter((event) => event.kind === "turn" && event.data.transport === "provider-native");
    const ids = new Set(receipts.map((event) => event.data.semanticTurnId));
    return { brokerId: broker.brokerId, image: broker.container?.image, facts: { instructions, receipts },
      provenance: { "late-turn-not-reused": "provider-native", "second-instruction-completed": "provider-native" } as const,
      checks: { "distinct-instructions": first.id !== second.id && one.expectedTurn !== undefined && two.expectedTurn === one.expectedTurn + 1,
        "late-turn-not-reused": ids.size === receipts.length && receipts.some((event) => event.data.turnNumber === two.expectedTurn),
        "second-instruction-completed": two.status === "completed" && two.completedAt !== undefined } };
  } finally { await broker.close(); }
}
export async function sentryOutageScenario(root: string, mode: EvalMode = "offline-scripted", live?: LiveEvalConfig) {
  let attempted = 0;
  const broker = await brokerFixture(root, { mode, ...(live ? { live } : {}), sink: { record: () => { attempted++; throw new Error("fixture-sink-unavailable"); }, health: () => ({ degraded: true }) } });
  try {
    const instruction = await broker.instruct(mode === "live-container" ? livePrompts["sentry-outage"] : "complete despite sink outage");
    await eventually(async () => (await broker.queue.list(broker.worker.id))[0]?.status === "completed", "SINK_BLOCKED_DELIVERY", broker.timeout);
    const events = await broker.activity.read(instruction.id, 0, 100), records = await broker.queue.list(broker.worker.id);
    return { brokerId: broker.brokerId, image: broker.container?.image, facts: { attempted, events, instructions: records }, checks: {
      "delivery-with-failing-sink": attempted > 0 && records[0]?.submittedAt !== undefined,
      "local-evidence-durable": events.some((event) => event.kind === "instruction.submitted"),
      "settlement-with-failing-sink": events.some((event) => event.kind === "instruction.settled") && records[0]?.status === "completed",
    } };
  } finally { await broker.close(); }
}
