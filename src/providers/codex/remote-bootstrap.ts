import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeAtomicPrivateFile } from "../../persistence/atomic-private-file.js";

const Receipt = z.object({ actorSessionId: z.string().min(1), nativeSessionId: z.string().min(1),
  cwd: z.string().min(1), createdAt: z.iso.datetime() }).strict();
export type CodexBootstrapReceipt = z.infer<typeof Receipt>;
export function bootstrapPath(home: string, actor: string): string {
  if (!/^[a-zA-Z0-9_-]+$/u.test(actor)) throw new Error("Invalid bootstrap actor");
  return join(home, "cyberdeck-bootstrap", `${actor}.json`);
}
export async function readBootstrap(home: string, actor: string): Promise<CodexBootstrapReceipt | undefined> {
  try { const receipt = Receipt.parse(JSON.parse(await readFile(bootstrapPath(home, actor), "utf8")));
    return receipt.actorSessionId === actor ? receipt : undefined;
  } catch { return undefined; }
}

/** A fresh thread/start response owns first-input readiness, never a transcript or completion.
 * Revocation is monotonic and serialized with publication, including cross-direction WS races. */
export class CodexRemoteBootstrap {
  private request?: { id: string | number; cwd: string };
  private nativeId?: string;
  private revoked = false;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly home: string, private readonly actor: string) {}
  async outgoing(data: string): Promise<void> {
    const frame = JSON.parse(data);
    if (frame.method === "thread/start") {
      if (this.request || frame.params?.ephemeral === true
        || !["string", "number"].includes(typeof frame.id) || typeof frame.params?.cwd !== "string") {
        await this.revoke(); return;
      }
      this.request = { id: frame.id, cwd: frame.params.cwd };
    } else if (typeof frame.method === "string" && (/^turn\//u.test(frame.method) || frame.method === "review/start"
      || /^thread\/(resume|fork|rollback|compact|archive|queue\/|realtime\/|inject_items|sample|shellCommand|revert|prepareApprovedPlan)/u.test(frame.method))) await this.revoke();
  }
  async incoming(data: string): Promise<void> {
    const frame = JSON.parse(data);
    // Other native clients can start work too. A notification can revoke before the start reply.
    if (typeof frame.method === "string" && /^(thread\/(queue\/|realtime\/|compacted|reverted|archived|deleted|closed)|turn\/|item\/|error$)/u.test(frame.method)
      || frame.method === "thread/status/changed"
      && frame.params?.status?.type === "active") {
      if (!this.nativeId || frame.params?.threadId === undefined || frame.params.threadId === this.nativeId) await this.revoke();
    }
    if (!this.request || frame.id !== this.request.id || frame.method !== undefined || this.revoked) return;
    const thread = frame.result?.thread;
    if (frame.error !== undefined || typeof thread?.id !== "string" || thread.cwd !== this.request.cwd
      || !Array.isArray(thread.turns) || thread.turns.length !== 0) { await this.revoke(); return; }
    this.nativeId = thread.id;
    const receipt: CodexBootstrapReceipt = { actorSessionId: this.actor, nativeSessionId: thread.id,
      cwd: thread.cwd, createdAt: new Date().toISOString() };
    this.tail = this.tail.then(async () => {
      if (!this.revoked) await writeAtomicPrivateFile(bootstrapPath(this.home, this.actor), JSON.stringify(receipt) + "\n");
    });
    await this.tail;
  }
  async revoke(): Promise<void> {
    this.revoked = true;
    const remove = () => rm(bootstrapPath(this.home, this.actor), { force: true });
    this.tail = this.tail.then(remove, remove);
    await this.tail;
  }
}
