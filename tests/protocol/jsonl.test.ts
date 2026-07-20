import { describe, expect, it } from "vitest";
import { WireFrameSchema } from "../../src/protocol/frames.js";
import { JsonlDecoder, encodeFrame } from "../../src/protocol/jsonl.js";

describe("JsonlDecoder", () => {
  it("buffers fragments and returns every completed validated frame", () => {
    const frames = [
      { type: "request", id: 1, method: "session.list", params: {} },
      { type: "input", sessionId: crypto.randomUUID(), data: Buffer.from("hello").toString("base64") },
      { type: "detach", sessionId: crypto.randomUUID() },
    ] as const;
    const encoded = Buffer.concat(frames.map((frame) => encodeFrame(frame)));
    const splitAt = Math.floor(encodeFrame(frames[0]).length / 2);
    const decoder = new JsonlDecoder(WireFrameSchema);

    expect(decoder.push(encoded.subarray(0, splitAt))).toEqual([]);
    expect(decoder.push(encoded.subarray(splitAt))).toEqual(frames);
  });

  it("emits a protocol error for malformed lines and continues", () => {
    const decoder = new JsonlDecoder(WireFrameSchema);
    const valid = { type: "request", id: 2, method: "session.list", params: {} } as const;
    const decoded = decoder.push(Buffer.concat([Buffer.from("not-json\n"), encodeFrame(valid)]));

    expect(decoded[0]).toMatchObject({ type: "protocol-error", code: "INVALID_FRAME" });
    expect(decoded[1]).toEqual(valid);
  });
});
