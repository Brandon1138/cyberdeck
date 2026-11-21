import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ModalAnswerGrant, ModalAnswerGrantStatus } from "../domain/modal-answer.js";
import { openPrivateAppendFile } from "./private-files.js";

const execFileAsync = promisify(execFile);

export type { ModalAnswerGrant, ModalAnswerGrantStatus } from "../domain/modal-answer.js";

const ModalAnswerGrantEventSchema = z.object({
  recordType: z.enum(["modal-answer.granted", "modal-answer.revoked"]),
  eventId: z.uuid(),
  occurredAt: z.iso.datetime(),
  root: z.string().min(1),
  authority: z.literal("operator"),
});

export interface ModalAnswerGrantStoreOptions {
  now?: () => string;
  idFactory?: () => string;
  /** Must resolve an exact repository primary-checkout root, refusing anything else. */
  canonicalize?: (path: string) => Promise<string>;
}

/**
 * Append-only operator ledger for automated modal answering and provision-time trust.
 *
 * Automated answering is **on by default** for every repository: Cyberdeck is semi-autonomous, and
 * a trust dialog on a worktree it just provisioned is exactly the prompt an orchestrator should
 * clear. The ledger therefore records the operator's *opt-outs*: a root whose latest record is
 * `modal-answer.revoked` is off until a later `modal-answer.granted` switches it back on. A root
 * with no record at all is on. Which prompt kinds and answers are ever automatable is still the
 * policy layer's decision; this ledger only says whether the operator switched a repository off.
 *
 * Deliberately separate from any orchestrator binding, exactly like the Scout egress ledger:
 * replacing an Orc must not erase a repository decision the operator already made, and no MCP tool
 * is exposed for mutating this store. Keyed on the canonical primary checkout root; resolving a
 * worker's worktree to that root is the policy layer's job, not this ledger's.
 */
export class ModalAnswerGrantStore {
  readonly path: string;
  private writeTail = Promise.resolve();

  constructor(
    stateDirectory: string,
    private readonly options: ModalAnswerGrantStoreOptions = {},
  ) {
    this.path = join(stateDirectory, "orchestration", "modal-answer-grants.jsonl");
  }

  async set(root: string, enabled: boolean): Promise<ModalAnswerGrant | undefined> {
    const canonicalRoot = await this.canonical(root);
    const operation = this.writeTail.catch(() => undefined).then(async () => {
      const ledger = await this.readLedger();
      const existing = ledger.active.get(canonicalRoot);
      const revoked = ledger.revoked.has(canonicalRoot);
      // On is the default: granting a root that is not switched off appends nothing.
      if (enabled && !revoked) return existing;
      if (!enabled && revoked) return undefined;

      const occurredAt = this.options.now?.() ?? new Date().toISOString();
      const record = ModalAnswerGrantEventSchema.parse({
        recordType: enabled ? "modal-answer.granted" : "modal-answer.revoked",
        eventId: this.options.idFactory?.() ?? randomUUID(),
        occurredAt,
        root: canonicalRoot,
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
        ? { root: canonicalRoot, authority: "operator" as const, grantedAt: occurredAt }
        : undefined;
    });
    this.writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /**
   * Whether automated answers are on for an already-canonical repository root: true unless the
   * operator switched exactly that root off. No path resolution here, and no widening: a revoked
   * root says nothing about its parents or children, which are on by default like any other root.
   */
  async allowsRoot(canonicalRoot: string): Promise<boolean> {
    await this.writeTail;
    return !(await this.readLedger()).revoked.has(canonicalRoot);
  }

  async status(root: string): Promise<ModalAnswerGrantStatus> {
    const canonicalRoot = await this.canonical(root);
    await this.writeTail;
    const ledger = await this.readLedger();
    const grant = ledger.active.get(canonicalRoot);
    return {
      root: canonicalRoot,
      enabled: !ledger.revoked.has(canonicalRoot),
      ...(grant === undefined ? {} : { grant }),
    };
  }

  /** Explicit grants on record. A root absent here is still on unless `revoked()` names it. */
  async list(): Promise<ModalAnswerGrant[]> {
    await this.writeTail;
    return [...(await this.readLedger()).active.values()]
      .sort((left, right) => left.root.localeCompare(right.root));
  }

  /** Roots the operator switched off, sorted. */
  async revoked(): Promise<string[]> {
    await this.writeTail;
    return [...(await this.readLedger()).revoked].sort();
  }

  private async readLedger(): Promise<{
    active: Map<string, ModalAnswerGrant>;
    revoked: Set<string>;
  }> {
    const content = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const active = new Map<string, ModalAnswerGrant>();
    const revoked = new Set<string>();
    const lines = content.split("\n");
    if (!content.endsWith("\n")) lines.pop();
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      let event: z.infer<typeof ModalAnswerGrantEventSchema>;
      try {
        event = ModalAnswerGrantEventSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`Invalid modal answer grant at line ${index + 1}`, { cause: error });
      }
      if (event.recordType === "modal-answer.revoked") {
        active.delete(event.root);
        revoked.add(event.root);
      } else {
        revoked.delete(event.root);
        active.set(event.root, {
          root: event.root,
          authority: event.authority,
          grantedAt: event.occurredAt,
        });
      }
    }
    return { active, revoked };
  }

  private canonical(path: string): Promise<string> {
    return (this.options.canonicalize ?? canonicalModalAnswerRoot)(path);
  }
}

/**
 * Resolve an exact repository root, refusing subdirectories, symlink aliases, and parents. A modal
 * answer grant on a parent directory would silently cover every repository under it, which is the
 * widening this refusal exists to prevent.
 */
export async function canonicalModalAnswerRoot(path: string): Promise<string> {
  const canonical = await realpath(path);
  const { stdout } = await execFileAsync(
    "git",
    ["--no-optional-locks", "-C", canonical, "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  );
  const repositoryRoot = await realpath(stdout.trim());
  if (repositoryRoot !== canonical) {
    throw new Error(
      `Modal answer grant root must be the exact Git repository root: ${repositoryRoot}`,
    );
  }
  return repositoryRoot;
}
