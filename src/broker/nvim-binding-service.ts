import { z } from "zod";
import type { SessionRecord } from "../domain/session.js";
import { callNvim, type NvimEntryPoint } from "../nvim/bridge.js";
import { isWorkerLive, worktreeSubject } from "../nvim/open-worktree.js";
import { worktreeRequest, type NvimWorktreeRequest } from "../nvim/quickfix.js";
import { worktreeChanges, type WorktreeChangeSet } from "../nvim/worktree-changes.js";

export const NvimBindParamsSchema = z.object({
  sessionId: z.uuid(),
  /** Derived by the client from the tmux pane nvim occupies; never chosen by the caller. */
  address: z.string().trim().min(1).max(4_096),
  /**
   * The flag the client already sent nvim, not the worker's state now.
   *
   * The client reads the session, sends `open`, and only then binds, so the worker can reach its
   * terminal state inside that window. Being told what nvim was locked with is what lets this
   * service notice a transition that happened before it was ever watching.
   */
  live: z.boolean(),
});

export type NvimBindParams = z.infer<typeof NvimBindParamsSchema>;

export interface NvimBinding {
  sessionId: string;
  address: string;
  worktree: string;
}

interface SessionCatalog {
  get(sessionId: string): SessionRecord;
}

export interface NvimBindingServiceOptions {
  sessions: SessionCatalog;
  onSessionUpdate: (listener: (sessionId: string) => void) => () => void;
  changes?: ((cwd: string) => Promise<WorktreeChangeSet>) | undefined;
  notify?: ((options: {
    address: string;
    entryPoint: NvimEntryPoint;
    request: NvimWorktreeRequest;
  }) => void) | undefined;
}

/**
 * Which nvim is showing which worker's worktree, and nothing else.
 *
 * The map is in memory on purpose. An address is only meaningful while the nvim that owns it is
 * still running in the pane it was derived from, and a broker that has restarted knows neither.
 * Persisting it would let a restarted broker push a completed worker's file list into whatever
 * nvim later happens to occupy that pane number. Losing the association costs one keypress.
 *
 * Only the worker's own terminal transition drives anything here: no timers, no watchers, no
 * polling. The registry is subscribed to {@link SessionRegistry.onSessionUpdate} and settles a
 * binding the first time its session stops being live.
 */
export class NvimBindingService {
  readonly #bindings = new Map<string, NvimBinding>();
  readonly #options: NvimBindingServiceOptions;
  #unsubscribe: (() => void) | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: NvimBindingServiceOptions) {
    this.#options = options;
  }

  start(): void {
    this.#unsubscribe ??= this.#options.onSessionUpdate((sessionId) => {
      this.#queue(() => this.settle(sessionId));
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#bindings.clear();
  }

  /**
   * Record that this nvim is showing this worker. A session that is already terminal is accepted
   * and left unbound: there is no later transition to wait for.
   *
   * Unbound is not the same as untouched. If the client locked nvim on the way in and the worker
   * went terminal before this call, the transition this service settles on is already behind it,
   * so the release has to be issued here or those buffers stay `nomodifiable` for the life of that
   * nvim. A client that already rendered the worker as finished asks for nothing, which is what
   * keeps the normal path — bind while live, settle on the transition — to one refresh.
   */
  bind(params: NvimBindParams): NvimBinding {
    const request = NvimBindParamsSchema.parse(params);
    const record = this.#options.sessions.get(request.sessionId);
    const binding: NvimBinding = {
      sessionId: record.id,
      address: request.address,
      worktree: record.cwd,
    };
    if (isWorkerLive(record)) this.#bindings.set(record.id, binding);
    else if (request.live) this.#queue(() => this.#release(binding, record));
    return binding;
  }

  binding(sessionId: string): NvimBinding | undefined {
    return this.#bindings.get(sessionId);
  }

  /**
   * One transition, one message: the final change set and the release of read-only travel together
   * as a single `refresh` carrying `live: false`.
   *
   * The binding is dropped whatever happens. A worker only goes terminal once, and an nvim that has
   * since been closed must not keep a completed session pinned in memory.
   */
  async settle(sessionId: string): Promise<void> {
    const binding = this.#bindings.get(sessionId);
    if (binding === undefined) return;
    let record: SessionRecord;
    try {
      record = this.#options.sessions.get(sessionId);
    } catch {
      this.#bindings.delete(sessionId);
      return;
    }
    if (isWorkerLive(record)) return;
    this.#bindings.delete(sessionId);
    await this.#release(binding, record);
  }

  /** Serialize against every other message this service sends to nvim. */
  #queue(work: () => Promise<void>): void {
    this.#tail = this.#tail.then(work, work);
  }

  async #release(binding: NvimBinding, record: SessionRecord): Promise<void> {
    try {
      const changes = await (this.#options.changes ?? worktreeChanges)(binding.worktree);
      const notify = this.#options.notify ?? callNvim;
      notify({
        address: binding.address,
        entryPoint: "refresh",
        request: worktreeRequest({
          session: binding.sessionId,
          worktree: binding.worktree,
          subject: worktreeSubject(record),
          live: false,
          changes,
        }),
      });
    } catch {
      // The operator closed nvim, or the worktree is gone. Neither is worth failing a broker
      // shutdown path over, and there is nothing left to retry against.
    }
  }

  /** Test seam: settle every transition observed so far. */
  async settled(): Promise<void> {
    await this.#tail;
  }
}
