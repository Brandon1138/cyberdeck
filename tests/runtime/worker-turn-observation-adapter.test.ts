import { describe, expect, it } from "vitest";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";

describe("WorkerTurnObservationAdapter", () => {
  it("keeps severed-tail provenance attached to the replay that produced it", () => {
    const adapter = new WorkerTurnObservationAdapter();
    const fatalText = "API Error: 401 authentication_error";
    const oversized = adapter.createReplay(128 * 1024);
    oversized.appendBytes(Buffer.from(`${"continuation ".repeat(400)}${fatalText}`));
    const severedTail = oversized.strippedTail(fatalText.length);
    expect(severedTail).toEqual({ text: fatalText, truncated: true });

    // Another session can be observed before this verdict is requested. Its tail must not replace
    // the truncation fact carried by the first replay and turn a severed fragment into a fatal line.
    const other = adapter.createReplay(128 * 1024);
    other.appendBytes(Buffer.from("healthy provider output\n"));
    other.strippedTail(4_000);

    expect(adapter.fatalTermination(severedTail, "2026-08-20T10:00:00.000Z"))
      .toBeUndefined();
  });
});
