import { describe, expect, it } from "vitest";
import {
  CapabilityGrantSchema,
  CyberdeckCapabilitySchema,
  grantAllows,
} from "../../src/domain/capability.js";

const SUBJECT = "11111111-1111-4111-8111-111111111111";

const grant = {
  subjectSessionId: SUBJECT,
  capabilities: ["thread.list", "worker.start"],
  scope: { kind: "workspace", cwd: "/repo/one" },
};

describe("CyberdeckCapabilitySchema", () => {
  // MIK-96: Cursor dispatch is no longer gated, so there is no capability left that could gate it.
  it("names no Cursor delegation capability", () => {
    expect(CyberdeckCapabilitySchema.options).not.toContain("worker.start.cursor");
    expect(CyberdeckCapabilitySchema.options).toContain("worker.start.fable");
  });
});

describe("CapabilityGrantSchema", () => {
  /**
   * Bindings are an append-only log. An operator who ever ran `/cursor-workers on` has
   * `worker.start.cursor` written into a record this build still has to read, so the retired name
   * parses away to nothing rather than making the whole binding unreadable.
   */
  it("drops a retired capability from a stored grant instead of refusing it", () => {
    const parsed = CapabilityGrantSchema.parse({
      ...grant,
      capabilities: ["thread.list", "worker.start", "worker.start.cursor"],
    });

    expect(parsed.capabilities).toEqual(["thread.list", "worker.start"]);
  });

  it("still refuses a capability name nothing ever granted", () => {
    expect(() =>
      CapabilityGrantSchema.parse({ ...grant, capabilities: ["worker.start.everything"] }),
    ).toThrow();
  });

  it("grants nothing for a retired capability that survived on disk", () => {
    expect(grantAllows(
      { ...grant, capabilities: ["worker.start", "worker.start.cursor"] } as never,
      "worker.start",
      { cwd: "/repo/one" },
    )).toBe(true);
  });
});
