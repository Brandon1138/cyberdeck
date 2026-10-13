import { describe, expect, it, vi } from "vitest";
import type { ProviderLaunchSpec } from "../../src/providers/provider.js";

const fake = vi.hoisted(() => ({ exit: undefined as undefined | ((exit: { exitCode: number; signal?: number }) => void) }));
vi.mock("node-pty", () => ({ spawn: () => ({
  pid: 1234, onData: () => {}, onExit: (listener: typeof fake.exit) => { fake.exit = listener; },
  write: () => {}, resize: () => {}, kill: () => {},
}) }));
import { PtyProcess } from "../../src/runtime/pty-process.js";

const spec: ProviderLaunchSpec = { executable: "fake", args: [], cwd: "/tmp", env: {} };

describe("PTY exit delivery across asynchronous adoption", () => {
  it("replays an exit observed before the registry subscribes, including its signal", async () => {
    const runtime = new PtyProcess(spec, 1024);
    fake.exit!({ exitCode: 17, signal: 9 });
    const listener = vi.fn();
    runtime.onExit(listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledExactlyOnceWith(17, 9);
    fake.exit!({ exitCode: 99 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("honors unsubscription before a queued late exit callback", async () => {
    const runtime = new PtyProcess(spec, 1024);
    fake.exit!({ exitCode: 1 });
    const listener = vi.fn();
    runtime.onExit(listener)();
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });
});
