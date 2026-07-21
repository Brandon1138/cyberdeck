import { describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_SCHEMA_VERSION,
  ControlPlaneErrorCodeSchema,
  JobIdSchema,
  SchemaVersionSchema,
  TimestampSchema,
} from "../../src/domain/control-plane.js";

describe("control-plane primitives", () => {
  it("pins the current schema version", () => {
    expect(CONTROL_PLANE_SCHEMA_VERSION).toBe(1);
    expect(SchemaVersionSchema.parse(CONTROL_PLANE_SCHEMA_VERSION)).toBe(1);
  });

  it("accepts a future schema version so an older reader can gate on it", () => {
    expect(SchemaVersionSchema.parse(2)).toBe(2);
    expect(() => SchemaVersionSchema.parse(0)).toThrow();
  });

  it("brands identifiers and requires a UUID", () => {
    const id = JobIdSchema.parse(crypto.randomUUID());
    expect(typeof id).toBe("string");
    expect(() => JobIdSchema.parse("not-a-uuid")).toThrow();
  });

  it("validates ISO timestamps", () => {
    expect(TimestampSchema.parse("2026-07-21T00:00:00.000Z")).toContain("2026");
    expect(() => TimestampSchema.parse("yesterday")).toThrow();
  });

  it("closes the error-code enum against unknown codes", () => {
    expect(ControlPlaneErrorCodeSchema.parse("PROVIDER_NOT_REGISTERED")).toBe("PROVIDER_NOT_REGISTERED");
    expect(() => ControlPlaneErrorCodeSchema.parse("NOPE")).toThrow();
  });
});
