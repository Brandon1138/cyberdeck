import { realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { ANSWERABLE_MODAL_KINDS, type ModalKind } from "../domain/modal-descriptor.js";

/** The two git questions root resolution needs; `GitWorkspaceProbe` satisfies it structurally. */
export interface ModalAnswerRepositoryProbe {
  gitCommonDirectory(path: string): Promise<string | undefined>;
  primaryWorktree(gitDir: string): Promise<string | undefined>;
}

export interface ModalAnswerGrantReader {
  allowsRoot(canonicalRoot: string): Promise<boolean>;
}

export interface ModalAnswerPolicyDecision {
  allowed: boolean;
  /** One sentence a refusal can be returned with verbatim. */
  reason: string;
  /** The canonical repository root the decision was made against, when one resolved. */
  root?: string;
}

export interface ModalAnswerPolicyOptions {
  grants: ModalAnswerGrantReader;
  probe: ModalAnswerRepositoryProbe;
  canonicalize?: (path: string) => Promise<string>;
}

/**
 * The one place an automated answer is allowed or refused.
 *
 * Two independent conditions, both operator-legible: the modal kind must be in the domain's
 * answerable set (a per-action permission approval or a login prompt never is), and the worker's
 * cwd must resolve to a repository whose primary checkout root the operator granted. A linked
 * worktree resolves to the repository it belongs to — `git rev-parse --git-common-dir` from any
 * worktree names the primary `.git` — which is precisely how a grant on a repository covers the
 * worktrees Cyberdeck provisions into it. Prompts failing either condition surface to the operator
 * exactly as before; nothing here widens silently.
 */
export class ModalAnswerPolicy {
  constructor(private readonly options: ModalAnswerPolicyOptions) {}

  async evaluate(input: { cwd: string; kind: ModalKind }): Promise<ModalAnswerPolicyDecision> {
    if (!ANSWERABLE_MODAL_KINDS.has(input.kind)) {
      return {
        allowed: false,
        reason: `Modal kind ${input.kind} is never answerable by policy; it stays with the operator`,
      };
    }
    const root = await this.repositoryRootOf(input.cwd);
    if (root === undefined) {
      return {
        allowed: false,
        reason: "Worker cwd does not resolve to a Git repository, so no grant can cover it",
      };
    }
    if (!(await this.options.grants.allowsRoot(root))) {
      return {
        allowed: false,
        reason: `No operator modal-answer grant covers ${root}; grant one with \`cyberdeck modal-answers on --root ${root}\``,
        root,
      };
    }
    return { allowed: true, reason: `Operator grant covers ${root}`, root };
  }

  /** Whether provision-time workspace trust may be written for this cwd. */
  async allowsWorkspaceTrust(cwd: string): Promise<boolean> {
    return (await this.evaluate({ cwd, kind: "workspace-trust" })).allowed;
  }

  /**
   * The primary checkout root of the repository `cwd` belongs to, however deep and whether or not
   * `cwd` is a linked worktree. The common git directory of a normal checkout is `<root>/.git`;
   * when it is not (`--separate-git-dir`, bare), git's own bookkeeping names the primary worktree.
   */
  private async repositoryRootOf(cwd: string): Promise<string | undefined> {
    const common = await this.options.probe.gitCommonDirectory(cwd);
    if (common === undefined) return undefined;
    const primary = basename(common) === ".git"
      ? dirname(common)
      : await this.options.probe.primaryWorktree(common);
    if (primary === undefined) return undefined;
    try {
      return await (this.options.canonicalize ?? realpath)(primary);
    } catch {
      return undefined;
    }
  }
}
