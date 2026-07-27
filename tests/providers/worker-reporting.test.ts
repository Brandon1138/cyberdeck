import { describe, expect, it } from "vitest";
import { addWorkerReportingGuidance } from "../../src/providers/worker-reporting.js";

describe("worker reporting launch guidance", () => {
  it("adds concise provider-neutral usage once", () => {
    const workerId = "11111111-1111-4111-8111-111111111111";
    const prompt = addWorkerReportingGuidance("Run tests.", workerId);
    expect(prompt).toContain(`cyberdeck event submit --worker ${workerId}`);
    expect(prompt).toContain("DECISION_REQUEST");
    expect(addWorkerReportingGuidance(prompt, workerId)).toBe(prompt);
  });
});
