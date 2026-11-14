import { describe, expect, it } from "vitest";
import { ReplayDigest } from "../../src/runtime/replay-digest.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";

const status = (state: string) => `\u001b]7501;state=${state}:app=codex\u001b\\`;

describe("Codex explicit work intervals", () => {
  it("keeps the cycle across arbitrary chunk seams and redraws, then identifies new remote work", () => {
    const text = status("working") + "streaming redraw" + status("working") + status("done");
    for (let seam = 0; seam <= text.length; seam++) {
      const digest = new ReplayDigest();
      digest.append(text.slice(0, seam));
      digest.append(text.slice(seam));
      expect(digest.codexWorkCycle()).toEqual({ id: 1, active: false });
      digest.append(status("working"));
      expect(digest.codexWorkCycle()).toEqual({ id: 2, active: true });
      digest.append(status("idle"));
      expect(digest.codexWorkCycle()).toEqual({ id: 2, active: false });
    }
  });

  it("does not infer a work interval from prose, another app, or nested OSC payloads", () => {
    const digest = new ReplayDigest();
    digest.append("7501;state=working:app=codex");
    digest.append("\u001b]7501;state=working:app=other\u0007");
    digest.append("\u001b]52;clipboard;" + status("working"));
    digest.append(status("done"));
    expect(digest.codexWorkCycle()).toBeUndefined();
    digest.append("\u001b]52;" + "x".repeat(ReplayDigest.MAX_CARRY_CHARS + 1));
    digest.append(status("working"));
    expect(digest.codexWorkCycle()).toBeUndefined();
  });

  it("exposes intervals only for Codex and resets them with the runtime replay", () => {
    const replay = new WorkerTurnObservationAdapter().createReplay(128 * 1024);
    replay.appendBytes(Buffer.from(status("working")));
    expect(replay.workCycle?.("codex")).toEqual({ id: 1, active: true });
    expect(replay.workCycle?.("claude")).toBeUndefined();
    replay.reset("");
    expect(replay.workCycle?.("codex")).toBeUndefined();
  });
});
