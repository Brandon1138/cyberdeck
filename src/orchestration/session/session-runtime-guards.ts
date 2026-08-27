import type { SessionRuntime } from "../../domain/session-runtime.js";
import { RegistryError, type RuntimeSession } from "./session-registry-ports.js";

/**
 * The refusals every input path shares, and the one attachment fact derived from them.
 *
 * These are stated once here because a session that is finalizing its last durable turn, or has no
 * process at all, or is a one-shot headless Scout, must be refused identically whether the caller
 * arrived through `write`, `submit`, `resize`, or an attachment.
 */

/**
 * Refresh what the provider's input surface is holding.
 *
 * Called from the broadcast path and from anything that is about to make a claim about the
 * worker, because a claim made from a composer reading taken minutes ago is the class of lie this
 * whole change exists to stop.
 */
export function requireSessionRuntime(runtime: RuntimeSession): SessionRuntime {
  if (runtime.sessionRuntime === undefined) {
    throw new RegistryError("SESSION_NOT_ACTIVE", "Session runtime is not active; resume it before use");
  }
  return runtime.sessionRuntime;
}

export function requireTerminalFinalizationComplete(runtime: RuntimeSession): void {
  if (runtime.terminalFinalizing !== true) return;
  throw new RegistryError(
    "SESSION_NOT_ACTIVE",
    "Session is finalizing its last durable turn",
  );
}

export function requireInteractiveInput(runtime: RuntimeSession): void {
  if (runtime.record.scout?.transport === "headless-stream-json") {
    throw new RegistryError(
      "SESSION_BUSY",
      "A headless Scout is one-shot and accepts no follow-up input; launch a new Scout probe",
    );
  }
}

export function updateAttachmentState(runtime: RuntimeSession): void {
  runtime.record.attachmentState = runtime.controller !== undefined
    ? "controlled"
    : runtime.watchers.size > 0
      ? "watched"
      : "detached";
  runtime.record.updatedAt = new Date().toISOString();
}
