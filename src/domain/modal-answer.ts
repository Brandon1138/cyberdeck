import { z } from "zod";

/**
 * The operator's durable per-repository switch for automated modal answering.
 *
 * Answering is on by default; this record exists for the operator to switch one repository off, or
 * back on after that. Mutated only through the CLI, never through an MCP tool, and keyed on the
 * repository's primary checkout root so one decision covers that checkout and every linked
 * worktree of it — a worktree Cyberdeck provisions for a worker is exactly the case this exists for.
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
