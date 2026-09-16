import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SessionLaunchIntentSchema, type SessionLaunchIntent, type SessionLaunchIntentPort } from "../domain/session-launch-intent.js";

const Snapshot = z.object({ schemaVersion: z.literal(1), intents: z.array(SessionLaunchIntentSchema).max(384) }).strict();
/** Shares the installation owner's lifetime; a test broker cannot choose a second ownership scope. */
export class SessionLaunchIntentStore implements SessionLaunchIntentPort {
  private tail: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private revision = 0;
  private constructor(private readonly directory: string, private readonly assertOwner: () => void,
    private intents: SessionLaunchIntent[]) {}
  static async open(directory: string, assertOwner: () => void): Promise<SessionLaunchIntentStore> {
    assertOwner();
    let intents: SessionLaunchIntent[] = [];
    try {
      const handle = await open(join(directory, "session-launch-intents.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("SESSION_LAUNCH_INTENTS_NOT_PRIVATE_REGULAR_FILE");
        if (metadata.size > 16 * 1024 ** 2) throw new Error("SESSION_LAUNCH_INTENTS_TOO_LARGE");
        const bytes = Buffer.alloc(16 * 1024 ** 2 + 1);
        let length = 0;
        while (length < bytes.length) {
          const chunk = await handle.read(bytes, length, bytes.length - length, length);
          if (!chunk.bytesRead) break;
          length += chunk.bytesRead;
        }
        if (length > 16 * 1024 ** 2) throw new Error("SESSION_LAUNCH_INTENTS_TOO_LARGE");
        intents = Snapshot.parse(JSON.parse(bytes.subarray(0, length).toString("utf8"))).intents;
        if (new Set(intents.map(b => b.record.id)).size !== intents.length
          || new Set(intents.map(b => b.requestId)).size !== intents.length) throw new Error("SESSION_LAUNCH_INTENT_DUPLICATE");
      } finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return new SessionLaunchIntentStore(directory, assertOwner, intents);
  }
  version(): number { this.assertOwner(); return this.revision; }
  list(): SessionLaunchIntent[] { this.assertOwner(); return structuredClone(this.intents); }
  get(sessionId: string): SessionLaunchIntent | undefined {
    this.assertOwner();
    const intent = this.intents.find(b => b.record.id === sessionId);
    return intent ? structuredClone(intent) : undefined;
  }
  put(input: SessionLaunchIntent, expectedPhase?: SessionLaunchIntent["phase"]): Promise<void> {
    const intent = SessionLaunchIntentSchema.parse(input);
    const result = this.tail.then(async () => {
      this.assertOwner();
      if (this.poisoned) throw new Error("SESSION_LAUNCH_INTENTS_UNAVAILABLE");
      const prior = this.get(intent.record.id);
      if (prior && (prior.requestId !== intent.requestId || prior.record.generation !== intent.record.generation))
        throw new Error("SESSION_LAUNCH_INTENT_CONFLICT");
      if (expectedPhase !== undefined && prior?.phase !== expectedPhase) throw new Error("SESSION_LAUNCH_INTENT_PHASE_CHANGED");
      const phases = ["preparing", "ready", "launching", "terminal"];
      if (prior && (prior.phase === "terminal" || phases.indexOf(intent.phase) < phases.indexOf(prior.phase)))
        throw new Error("SESSION_LAUNCH_INTENT_REGRESSION");
      const remaining = this.intents.filter(b => b.record.id !== intent.record.id);
      const active = remaining.filter(b => b.phase !== "terminal");
      if (intent.phase !== "terminal" && active.length >= 256) throw new Error("SESSION_LAUNCH_INTENT_BACKPRESSURE");
      // Terminal input is an evaluator source. Until capture is acknowledged, retention may
      // backpressure new work but must never silently erase the submitted attempt.
      if (remaining.length >= 384) throw new Error("SESSION_LAUNCH_INTENT_BACKPRESSURE");
      const intents = [...remaining, intent];
      await this.writeSnapshot(intents);
    });
    this.tail = result.catch(() => undefined); return result;
  }
  ackTerminal(sessionId: string, requestId: string, terminalAt: string): Promise<void> {
    const result = this.tail.then(async () => {
      this.assertOwner();
      if (this.poisoned) throw new Error("SESSION_LAUNCH_INTENTS_UNAVAILABLE");
      const prior = this.get(sessionId);
      if (!prior) return;
      if (prior.phase !== "terminal" || prior.requestId !== requestId || prior.terminalAt !== terminalAt)
        throw new Error("SESSION_LAUNCH_INTENT_ACK_MISMATCH");
      await this.writeSnapshot(this.intents.filter(intent => intent.record.id !== sessionId));
    });
    this.tail = result.catch(() => undefined); return result;
  }

  private async writeSnapshot(intents: SessionLaunchIntent[]): Promise<void> {
      const snapshot = Snapshot.parse({ schemaVersion: 1, intents });
      const serialized = JSON.stringify(snapshot);
      if (Buffer.byteLength(serialized) > 16 * 1024 ** 2) throw new Error("SESSION_LAUNCH_INTENTS_TOO_LARGE");
      const path = join(this.directory, `session-launch-intents-${randomUUID()}.tmp`);
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(serialized); await handle.sync();
        this.assertOwner();
        await rename(path, join(this.directory, "session-launch-intents.json"));
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
        this.intents = intents; this.revision++;
      } catch (error) { this.poisoned = true; throw error; }
      finally { await handle.close(); }
  }

}
