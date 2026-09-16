import { expect, test, vi } from "vitest";
import type { InstructionRecord } from "../../src/domain/instruction.js";
import { InstructionParkingReadModel } from "../../src/orchestration/instruction-parking-read-model.js";
const record = { id: "instruction", targetSessionId: "session", status: "accepted" } as InstructionRecord;
test("input latches synchronously before fsync and concurrent writes remain unknown until all commit", () => {
  const model = new InstructionParkingReadModel([]), wake = vi.fn(); model.bindWake(wake);
  model.writing(record); expect(wake).toHaveBeenCalledWith("session");
  model.writing({ ...record, id: "second" });
  expect(model.read("session").known).toBe(false);
  model.committed(record); expect(model.read("session").known).toBe(false);
  model.committed({ ...record, id: "second" });
  expect(model.read("session")).toEqual({ known: true, statuses: ["accepted", "accepted"] });
});
test("a failed canonical write remains unknown and cannot be erased by a later successful write", () => {
  const model = new InstructionParkingReadModel([]); model.writing(record); model.failed(record);
  model.writing(record); model.committed({ ...record, status: "completed" });
  expect(model.read("session").known).toBe(false);
  model.forget("session"); expect(model.read("session")).toEqual({ known: true, statuses: [] });
});
test("startup wake requests survive composition and retention cap cannot look like an empty safe queue", () => {
  const model = new InstructionParkingReadModel([], 1), wake = vi.fn();
  model.writing(record); model.committed(record); model.bindWake(wake); expect(wake).toHaveBeenCalledWith("session");
  model.writing({ ...record, id: "overflow" }); model.committed({ ...record, id: "overflow" });
  expect(model.read("session").known).toBe(false);
});
test("canonical retirement reclaims never-parked records without discarding in-flight writes", () => {
  const model = new InstructionParkingReadModel([record], 1);
  model.writing(record); model.reconcileRetired(new Set());
  expect(model.read("session").statuses).toEqual(["accepted"]);
  model.committed(record); model.reconcileRetired(new Set());
  expect(model.read("session")).toEqual({ known: true, statuses: [] });
  const next = { ...record, id: "next", targetSessionId: "retained" };
  model.writing(next); model.committed(next); model.reconcileRetired(new Set(["retained"]));
  expect(model.read("retained")).toEqual({ known: true, statuses: ["accepted"] });
});
