import { describe, expect, it } from "vitest";
import { CYBERDECK_VERSION } from "../src/version.js";

describe("CYBERDECK_VERSION", () => {
  it("matches package version for the first release", () => {
    expect(CYBERDECK_VERSION).toBe("0.1.0");
  });
});
