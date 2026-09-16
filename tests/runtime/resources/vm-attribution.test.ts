import { expect, it } from "vitest";
import { attributeVm } from "../../../src/runtime/resources/vm-attribution.js";
it("keeps guest allocation and host physical views separate and charges all residual overhead", () => {
  const result = attributeVm(500, 100, 300, 50);
  expect(result.residualVmBytes).toBe(100);
  expect(result.attributedVmEstimateBytes).toBe(200);
  expect(result.conservativeVmUpperBytes).toBe(500);
});
it("does not infer residency when guest accounting exceeds physical memory", () => {
  expect(attributeVm(300, 400, 500, 50)).toMatchObject({ attributedVmEstimateBytes: 300, conservativeVmUpperBytes: 300, residualVmBytes: 0 });
  expect(attributeVm(null, 100, 100, 50).attributedVmEstimateBytes).toBeNull();
  expect(attributeVm(500, null, 100, 50).attributedVmEstimateBytes).toBeNull();
});
