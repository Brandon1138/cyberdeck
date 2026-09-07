import { z } from "zod";

/**
 * The operator's durable permission for automated modal answering, per repository.
 *
 * Answering a trust dialog is a security decision, so the grant is the operator's alone — mirroring
 * the Scout egress grant: a repository decision that outlives any orchestrator binding, mutated
 * only through the CLI, never through an MCP tool. One grant on a repository's primary checkout
 * root covers that checkout and every linked worktree of it, because a worktree Cyberdeck
 * provisions for a worker is exactly the case this exists for.
 */
export interface ModalAnswerGrant {
  /** Canonical primary-checkout root of the granted repository. */
  root: string;
  authority: "operator";
  grantedAt: string;
}

export interface ModalAnswerGrantStatus {
  root: string;
  enabled: boolean;
  grant?: ModalAnswerGrant;
}

export const ModalAnswersRequestSchema = z.object({
  root: z.string().min(1),
  enabled: z.boolean().optional(),
});
