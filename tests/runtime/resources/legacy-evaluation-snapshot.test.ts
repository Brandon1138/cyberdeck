import { expect, test, vi } from "vitest";
import type { AgentActivity } from "../../../src/domain/agent-activity.js";
import type { AgentActivityPort } from "../../../src/orchestration/agent-activity-port.js";
import { legacyEvaluationActivitySnapshot } from "../../../src/runtime/resources/legacy-evaluation-snapshot.js";

function fixture(firstSequence = 1, sequence = 2) {
  const bounds = { sourceId: "original", firstSequence, sequence, uncertain: false, captureGaps: 0 };
  const readGlobal = vi.fn(async (after: number, limit: number) => Array.from({ length: Math.min(sequence - after, limit) }, (_, i) =>
    ({ sequence: after + i + 1 }) as AgentActivity));
  const activity = { replayBounds: () => ({ ...bounds }), readGlobal } as unknown as AgentActivityPort;
  return { activity, bounds, readGlobal };
}
test("captures a fixed boundary without inventing already-pruned history", async () => {
  const f = fixture(5, 6);
  expect(await legacyEvaluationActivitySnapshot(f.activity)).toMatchObject({ sourceId: "original", throughSequence: 6,
    events: [{ sequence: 5 }, { sequence: 6 }] });
  expect(f.readGlobal).toHaveBeenCalledWith(4, 2);
});
test("refuses source replacement or inconsistent pages instead of sealing partial coverage", async () => {
  const f = fixture(); f.readGlobal.mockImplementationOnce(async () => { f.bounds.sourceId = "replacement"; return [{ sequence: 1 }, { sequence: 2 }] as AgentActivity[]; });
  await expect(legacyEvaluationActivitySnapshot(f.activity)).rejects.toThrow("ACTIVITY_CHANGED");
  const missing = fixture(); missing.readGlobal.mockResolvedValueOnce([{ sequence: 2 }] as AgentActivity[]);
  await expect(legacyEvaluationActivitySnapshot(missing.activity)).rejects.toThrow("ACTIVITY_GAP");
});
test("refuses capture uncertainty and oversized startup history before reading records", async () => {
  const f = fixture(1, 10001);
  await expect(legacyEvaluationActivitySnapshot(f.activity)).rejects.toThrow("ACTIVITY_LIMIT");
  expect(f.readGlobal).not.toHaveBeenCalled();
  f.bounds.uncertain = true;
  await expect(legacyEvaluationActivitySnapshot(f.activity)).rejects.toThrow("ACTIVITY_UNAVAILABLE");
});
