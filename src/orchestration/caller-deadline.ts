/** Bounds observation only. The operation may still finish; a timeout never authorizes retry. */
export async function callerDeadline<T>(operation: Promise<T>, timeoutMs: number, stage: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(Object.assign(new Error(`${stage} observation cancelled; operation outcome unknown`), { code: "CONTROL_PLANE_CANCELLED" }));
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(Object.assign(
        new Error(`${stage} exceeded ${timeoutMs}ms; outcome unknown. Reconcile durable state before retrying a mutation.`),
        { code: "CONTROL_PLANE_TIMEOUT" },
      )), Math.max(0, timeoutMs));
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) signal?.removeEventListener("abort", abort);
  }
}
