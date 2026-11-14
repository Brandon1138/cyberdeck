import { attachSession, type AttachTransport } from "./attach.js";
import type { StrigoiInspection } from "../orchestration/strigoi-ports.js";
/** Logical read-only watch. Explicit session watches and all human writers remain session-bound. */
export async function watchStrigoi(transport: AttachTransport, options: {
  attach?: typeof attachSession;
  pause?: () => Promise<void>;
} = {}): Promise<number> {
  let closed = false, lastSession: string | undefined;
  const unsubscribe = transport.onClose(() => { closed = true; });
  const pause = options.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 1000)));
  try {
    while (!closed) {
      const inspection = await transport.request<StrigoiInspection>("strigoi.inspect", {});
      if (inspection.state.desired !== "enabled") return 0;
      const id = inspection.state.activeBinding?.sessionId;
      if (id && id !== lastSession && inspection.runtime?.exitCode === null) {
        lastSession = id;
        await (options.attach ?? attachSession)({ transport, sessionId: id, mode: "watch", closeTransport: false });
        // Provider exit status is not a request to abandon residence; the lifecycle decides recovery.
        if (closed) return 1;
      } else await pause();
    }
    return 1;
  } finally { unsubscribe(); }
}
