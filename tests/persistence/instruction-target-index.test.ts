import { expect, it } from "vitest";
import { InstructionRecordSchema } from "../../src/domain/instruction.js";
import { indexedInstructionReceipt } from "../../src/persistence/instruction-target-index.js";

const renderedAt = "2026-11-16T12:00:00.000Z", completedAt = "2026-11-16T12:00:20.000Z";
const record = InstructionRecordSchema.parse({ id: "11111111-1111-4111-8111-111111111111",
  actorSessionId: "22222222-2222-4222-8222-222222222222", targetSessionId: "22222222-2222-4222-8222-222222222222",
  messageId: "33333333-3333-4333-8333-333333333333", message: "recover receipt", status: "queued", createdAt: renderedAt, updatedAt: renderedAt });
const ledger = { completedTurns: 2, canonicalTurns: 2,
  instructionTargets: [{ instructionId: record.id, expectedTurn: 1, renderedAt }] };

it("recovers the matching native completion time instead of the input or newest turn time", () => {
  expect(indexedInstructionReceipt(record, { ...ledger, turns: [
    { data: { turnNumber: 1, providerOccurredAt: completedAt } },
    { data: { turnNumber: 2, providerOccurredAt: "2026-11-16T12:01:00.000Z" } },
  ] })).toMatchObject({ status: "completed", renderedAt, submittedAt: renderedAt, completedAt });
});

it.each([undefined, {}, { providerOccurredAt: "invalid" }, { providerOccurredAt: renderedAt, nativeTimestampKnown: false },
  { providerOccurredAt: "2026-11-16T11:59:59.000Z" }])("does not fabricate a completion timestamp from missing or invalid evidence (%j)", data => {
  const receipt = indexedInstructionReceipt(record, { ...ledger, turns: data === undefined ? [] : [{ data: { turnNumber: 1, ...data } }] });
  expect(receipt?.status).toBe("completed");
  expect(receipt).not.toHaveProperty("completedAt");
});
