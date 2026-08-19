import { describe, expect, it } from "vitest";
import {
  SessionSnapshotParamsSchema,
  SessionSnapshotResultSchema,
} from "../../src/protocol/session-snapshot.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("session snapshot protocol", () => {
  it("keeps the cursor optional for legacy full-snapshot callers", () => {
    expect(SessionSnapshotParamsSchema.parse({ sessionId: SESSION_ID })).toEqual({
      sessionId: SESSION_ID,
    });
    expect(SessionSnapshotResultSchema.parse({ data: "UkVBRFk=" })).toEqual({
      data: "UkVBRFk=",
    });
  });

  it("accepts cursor-aware full and not-modified responses", () => {
    expect(SessionSnapshotParamsSchema.parse({ sessionId: SESSION_ID, cursor: 0 })).toEqual({
      sessionId: SESSION_ID,
      cursor: 0,
    });
    expect(SessionSnapshotResultSchema.parse({ data: "UkVBRFk=", cursor: 3 })).toEqual({
      data: "UkVBRFk=",
      cursor: 3,
    });
    expect(SessionSnapshotResultSchema.parse({ cursor: 3, notModified: true })).toEqual({
      cursor: 3,
      notModified: true,
    });
  });
});
