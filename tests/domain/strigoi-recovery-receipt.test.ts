import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { compactRecoverySourceMap, parseRecoveryAdoption, RECOVERY_SOURCE_MAP } from "../../src/domain/strigoi-recovery-receipt.js";
const identity = { sessionId: randomUUID(), incarnation: 2, generation: 1 };
const receipt = { identity, packetHash: "a".repeat(64), coverageId: randomUUID(), handledSourceIndices: [1], account: "Do not publish", recovery: { version: 1 } };
const mapping = RECOVERY_SOURCE_MAP + JSON.stringify(["b".repeat(64), "c".repeat(64)]);
it("falls back to full IDs before a large inventory exceeds the artifact budget", () => {
  expect(compactRecoverySourceMap(["a".repeat(64)])).toBe(JSON.stringify(["a".repeat(64)]));
  expect(compactRecoverySourceMap(Array.from({ length: 1000 }, (_, i) => i.toString(16).padStart(64, "0")))).toBeUndefined();
});
it("maps only inspected indices against the exact durable intent while preserving receipt identity and coverage", async () => {
  expect(await parseRecoveryAdoption(receipt, mapping)).toEqual({ identity, packetHash: receipt.packetHash, coverageId: receipt.coverageId,
    account: receipt.account, recovery: receipt.recovery, handledSourceIds: ["c".repeat(64)] });
});
it.each([[-1], [2], [0, 0], [0.5], ["0"]])("rejects invalid indices %j", async (...ids) => {
  expect(await parseRecoveryAdoption({ ...receipt, handledSourceIndices: ids }, mapping)).toBeUndefined();
});
it("rejects missing/ambiguous or model-supplied maps and retains legacy receipts", async () => {
  expect(await parseRecoveryAdoption(receipt, "")).toBeUndefined();
  expect(await parseRecoveryAdoption(receipt, mapping + "\n" + mapping)).toBeUndefined();
  expect(await parseRecoveryAdoption({ ...receipt, sourceMap: ["c".repeat(64)] }, mapping)).toBeUndefined();
  const { handledSourceIndices: _, ...rest } = receipt;
  const legacy = { ...rest, handledSourceIds: ["b".repeat(64)] };
  expect(await parseRecoveryAdoption(legacy, "old prompt")).toEqual(legacy);
});
