import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonicalScoutRepositoryRoot } from "../providers/cursor/workspace-state.js";
import type { ScoutEgressGrant, ScoutEgressStatus } from "../domain/scout-egress.js";
import { openPrivateAppendFile } from "./private-files.js";

export type { ScoutEgressGrant, ScoutEgressStatus } from "../domain/scout-egress.js";

const ScoutEgressEventSchema = z.object({
  recordType: z.enum(["scout-egress.granted", "scout-egress.revoked"]),
  eventId: z.uuid(),
  occurredAt: z.iso.datetime(),
  root: z.string().min(1),
  provider: z.literal("cursor"),
  profile: z.literal("scout"),
  access: z.literal("read-only"),
  authority: z.literal("operator"),
});

export interface ScoutEgressGrantStoreOptions {
  now?: () => string;
  idFactory?: () => string;
  canonicalize?: (path: string) => Promise<string>;
}

/**
 * Append-only operator grant ledger. It is deliberately separate from an Orc binding: replacing an
 * expensive Orc must not erase a repository decision the operator already made, and no MCP tool is
 * exposed for mutating this store.
 */
export class ScoutEgressGrantStore {
  readonly path: string;
  private writeTail = Promise.resolve();

  constructor(
    stateDirectory: string,
    private readonly options: ScoutEgressGrantStoreOptions = {},
  ) {
    this.path = join(stateDirectory, "orchestration", "scout-egress-grants.jsonl");
  }

  async set(root: string, enabled: boolean): Promise<ScoutEgressGrant | undefined> {
    const canonicalRoot = await this.canonical(root);
    const operation = this.writeTail.catch(() => undefined).then(async () => {
      const existing = (await this.readActive())
        .find((grant) => grant.root === canonicalRoot);
      if (enabled && existing !== undefined) return existing;
      if (!enabled && existing === undefined) return undefined;

      const occurredAt = this.options.now?.() ?? new Date().toISOString();
      const record = ScoutEgressEventSchema.parse({
        recordType: enabled ? "scout-egress.granted" : "scout-egress.revoked",
        eventId: this.options.idFactory?.() ?? randomUUID(),
        occurredAt,
        root: canonicalRoot,
        provider: "cursor",
        profile: "scout",
        access: "read-only",
        authority: "operator",
      });
      const handle = await openPrivateAppendFile(this.path);
      try {
        await handle.write(`${JSON.stringify(record)}\n`, undefined, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return enabled
        ? {
            root: canonicalRoot,
            provider: "cursor" as const,
            profile: "scout" as const,
            access: "read-only" as const,
            authority: "operator" as const,
            grantedAt: occurredAt,
          }
        : undefined;
    });
    this.writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async allows(root: string): Promise<boolean> {
    const canonicalRoot = await this.canonical(root);
    return (await this.list()).some((grant) => grant.root === canonicalRoot);
  }

  async status(root: string): Promise<ScoutEgressStatus> {
    const canonicalRoot = await this.canonical(root);
    const grant = (await this.list()).find((entry) => entry.root === canonicalRoot);
    return {
      root: canonicalRoot,
      enabled: grant !== undefined,
      ...(grant === undefined ? {} : { grant }),
    };
  }

  async list(): Promise<ScoutEgressGrant[]> {
    await this.writeTail;
    return this.readActive();
  }

  private async readActive(): Promise<ScoutEgressGrant[]> {
    const content = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const active = new Map<string, ScoutEgressGrant>();
    const lines = content.split("\n");
    if (!content.endsWith("\n")) lines.pop();
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      let event: z.infer<typeof ScoutEgressEventSchema>;
      try {
        event = ScoutEgressEventSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`Invalid Scout egress grant at line ${index + 1}`, { cause: error });
      }
      if (event.recordType === "scout-egress.revoked") {
        active.delete(event.root);
      } else {
        active.set(event.root, {
          root: event.root,
          provider: event.provider,
          profile: event.profile,
          access: event.access,
          authority: event.authority,
          grantedAt: event.occurredAt,
        });
      }
    }
    return [...active.values()].sort((left, right) => left.root.localeCompare(right.root));
  }

  private canonical(path: string): Promise<string> {
    return (this.options.canonicalize ?? canonicalScoutRepositoryRoot)(path);
  }
}
