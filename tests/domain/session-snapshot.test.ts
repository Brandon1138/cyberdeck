import { describe, expect, it } from "vitest";
import {
  SessionSnapshotParamsSchema,
  SessionSnapshotResultSchema,
} from "../../src/domain/session-snapshot.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("session snapshot protocol", () => {
  it("is a one-shot full read, requested by session alone", () => {
    expect(SessionSnapshotParamsSchema.parse({ sessionId: SESSION_ID })).toEqual({
      sessionId: SESSION_ID,
    });
    expect(SessionSnapshotResultSchema.parse({ data: "UkVBRFk=" })).toEqual({
      data: "UkVBRFk=",
    });
  });

  it("rejects the retired cursor protocol instead of silently serving it", () => {
    // A caller still sending a cursor is a stale Fleet that believes the list can poll replays
    // cheaply. It cannot — that belief cost every working session its full buffer per tick — so
    // the request fails loudly rather than degrading into exactly that traffic.
    expect(() => SessionSnapshotParamsSchema.parse({ sessionId: SESSION_ID, cursor: 0 }))
      .toThrow();
  });
});
