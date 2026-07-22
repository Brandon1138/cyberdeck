import { isAbsolute } from "node:path";
import { z } from "zod";

export const ProviderIdSchema = z.enum(["codex", "claude"]);
export const SandboxSchema = z.enum(["read-only", "workspace-write"]);
export const SessionExecutionStateSchema = z.enum([
  "starting",
  "active",
  "exited",
  "failed",
  "cancelled",
]);
export const AttachmentStateSchema = z.enum(["detached", "controlled", "watched"]);
export const SessionKindSchema = z.enum(["worker", "orchestrator"]);

export const StartSessionRequestSchema = z.object({
  provider: ProviderIdSchema,
  cwd: z.string().refine(isAbsolute, "cwd must be an absolute path"),
  detached: z.boolean(),
  sandbox: SandboxSchema,
  model: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  parentSessionId: z.uuid().optional(),
  kind: SessionKindSchema.optional(),
  providerInstructions: z.string().trim().min(1).optional(),
});

export const SessionRecordSchema = StartSessionRequestSchema.extend({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  executionState: SessionExecutionStateSchema,
  attachmentState: AttachmentStateSchema,
  pid: z.number().int().positive(),
  exitCode: z.number().int().nullable(),
  childIds: z.array(z.uuid()),
});

export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type Sandbox = z.infer<typeof SandboxSchema>;
export type SessionExecutionState = z.infer<typeof SessionExecutionStateSchema>;
export type AttachmentState = z.infer<typeof AttachmentStateSchema>;
export type SessionKind = z.infer<typeof SessionKindSchema>;
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>;
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
