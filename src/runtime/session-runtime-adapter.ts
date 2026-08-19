import type { SessionRuntime } from "../domain/session-runtime.js";
import type { ProviderLaunchSpec } from "../providers/provider.js";
import { PipeProcess } from "./pipe-process.js";
import { PtyProcess } from "./pty-process.js";

/** Select the shipped process adapter while exposing only the session-runtime port. */
export function createSessionRuntime(
  spec: ProviderLaunchSpec,
  replayBytes: number,
): SessionRuntime {
  return spec.transport === "pipe"
    ? new PipeProcess(spec, replayBytes)
    : new PtyProcess(spec, replayBytes);
}
