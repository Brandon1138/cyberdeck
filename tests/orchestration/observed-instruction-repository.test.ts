import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { InstructionRecord } from "../../src/domain/instruction.js";
import { observeInstructionRepository } from "../../src/orchestration/observed-instruction-repository.js";

const record: InstructionRecord = {
  id: randomUUID(), actorSessionId: randomUUID(), targetSessionId: randomUUID(),
  messageId: randomUUID(), message: "Continue", status: "queued", hop: 0,
  createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z",
};

describe("observeInstructionRepository", () => {
  it("observes the exact record only after the store write resolves", async () => {
    let finish!: () => void;
    const written = new Promise<void>((resolve) => { finish = resolve; });
    const put = vi.fn(() => written);
    const onPut = vi.fn();
    const repository = observeInstructionRepository({ put, list: async () => [] }, onPut);
    const pending = repository.put(record);
    expect(put).toHaveBeenCalledWith(record);
    expect(onPut).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(onPut).toHaveBeenCalledExactlyOnceWith(record);
    expect(onPut.mock.calls[0]?.[0]).toBe(record);
  });

  it("passes list filters, results and failures through", async () => {
    const records = [record];
    const list = vi.fn().mockResolvedValue(records);
    const repository = observeInstructionRepository({ put: async () => {}, list }, vi.fn());
    expect(await repository.list(record.targetSessionId)).toBe(records);
    expect(list).toHaveBeenLastCalledWith(record.targetSessionId);
    await repository.list();
    expect(list).toHaveBeenLastCalledWith(undefined);
    const failure = new Error("read failed");
    list.mockRejectedValueOnce(failure);
    await expect(repository.list()).rejects.toBe(failure);
  });

  it("propagates store failures without observing an unwritten record", async () => {
    const failure = new Error("write failed");
    const onPut = vi.fn();
    const repository = observeInstructionRepository({
      put: async () => { throw failure; }, list: async () => [],
    }, onPut);
    await expect(repository.put(record)).rejects.toBe(failure);
    expect(onPut).not.toHaveBeenCalled();
  });

  it.each([false, true])("isolates listener failure (async=%s)", async (asyncFailure) => {
    const onPut = asyncFailure ? async () => { throw new Error("listener failed"); }
      : () => { throw new Error("listener failed"); };
    const put = vi.fn(async () => {});
    const repository = observeInstructionRepository({ put, list: async () => [] }, onPut);
    await expect(repository.put(record)).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledExactlyOnceWith(record);
  });
});
