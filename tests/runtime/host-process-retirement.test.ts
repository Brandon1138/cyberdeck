import { expect, it, vi } from "vitest";
import { hostProcessGroupAbsent } from "../../src/runtime/host-process-retirement.js";
it("requires both the host leader and group absent and holds on permission errors or PID reuse", () => {
  const kill = vi.spyOn(process, "kill");
  try {
    kill.mockImplementation(() => { throw Object.assign(new Error("absent"), { code: "ESRCH" }); });
    expect(hostProcessGroupAbsent(1234, 1234)).toBe(true);
    expect(kill.mock.calls.map(c => c[0])).toEqual([1234, -1234]);
    kill.mockClear(); kill.mockImplementation(pid => { if (pid > 0) throw Object.assign(new Error("absent"), { code: "ESRCH" }); return true; });
    expect(hostProcessGroupAbsent(1234, 1234)).toBe(false);
    kill.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    expect(hostProcessGroupAbsent(1234, 1234)).toBe(false);
    kill.mockImplementation(() => true);
    expect(hostProcessGroupAbsent(1234, 1234)).toBe(false);
    kill.mockClear(); expect(hostProcessGroupAbsent(0, 0)).toBe(false); expect(hostProcessGroupAbsent(1, 1)).toBe(false);
    expect(hostProcessGroupAbsent(1234, 9876)).toBe(false); expect(kill).not.toHaveBeenCalled();
  } finally { kill.mockRestore(); }
});
