import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const BoundedTextSchema = z.string().trim().min(1).max(4_096);
export const MAX_SCOUT_REPORT_BYTES = 96 * 1024;
export const MIN_SCOUT_REPLAY_BYTES = 256 * 1024;

export const WorkerProfileSchema = z.enum(["scout"]);
export const WorkerLeasePolicySchema = z.enum([
  "expire-and-discard",
  "orphan-for-adoption",
]);

export const ScoutBudgetSchema = z.object({
  maxWallClockMs: z.number().int().positive().max(86_400_000),
  maxTokens: z.number().int().positive().max(10_000_000),
});

export const ScoutBriefSchema = z.object({
  objective: BoundedTextSchema,
  scope: z.array(BoundedTextSchema).min(1).max(256),
  questions: z.array(BoundedTextSchema).min(1).max(64),
  stopCondition: BoundedTextSchema,
  budget: ScoutBudgetSchema,
});

export const ScoutEvidenceReferenceSchema = z.object({
  path: BoundedTextSchema,
  symbol: BoundedTextSchema.optional(),
  lineRange: z.object({
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  }).refine(({ start, end }) => end >= start, "line range end must not precede start").optional(),
}).refine(
  ({ symbol, lineRange }) => symbol !== undefined || lineRange !== undefined,
  "evidence reference requires a symbol or line range",
);

export const ScoutFindingSchema = z.object({
  finding: BoundedTextSchema,
  evidence: z.array(ScoutEvidenceReferenceSchema).min(1).max(256),
});

export const ScoutReportSchema = z.object({
  findings: z.array(ScoutFindingSchema).min(1).max(256),
  coverage: z.object({
    searched: z.array(BoundedTextSchema).min(1).max(256),
    methods: z.array(BoundedTextSchema).min(1).max(256),
  }),
  uncertainties: z.array(BoundedTextSchema).max(256),
  suggestedFollowUpProbes: z.array(BoundedTextSchema).max(256),
}).refine(
  (report) => Buffer.byteLength(`${JSON.stringify(report, null, 2)}\n`) <= MAX_SCOUT_REPORT_BYTES,
  `Scout report must not exceed ${MAX_SCOUT_REPORT_BYTES} bytes`,
);

export const WorkerEffectiveStateSchema = z.object({
  lifecycle: z.literal("worker"),
  profile: z.literal("scout"),
  tier: z.literal(1),
  provider: z.literal("cursor"),
  model: z.literal("composer"),
  permissions: z.literal("read-only"),
  approvalMode: z.literal("auto"),
  leasePolicy: WorkerLeasePolicySchema,
});

export const ScoutCanaryStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("verified"),
    verifiedAt: z.iso.datetime(),
  }),
  z.object({
    status: z.literal("failed"),
    failedAt: z.iso.datetime(),
    reason: z.string().min(1),
  }),
]);

export const ScoutTerminalStateSchema = z.enum(["complete", "budget_exhausted"]);
export const ScoutReportStateSchema = z.enum(["missing", "partial", "invalid", "complete"]);

export const ScoutRuntimeStateSchema = z.object({
  dropBoxPath: z.string().refine(isAbsolute, "drop-box path must be absolute"),
  reportPath: z.string().refine(isAbsolute, "report path must be absolute"),
  canary: ScoutCanaryStateSchema,
  reportState: ScoutReportStateSchema,
  terminalState: ScoutTerminalStateSchema.optional(),
});

export type WorkerProfile = z.infer<typeof WorkerProfileSchema>;
export type WorkerLeasePolicy = z.infer<typeof WorkerLeasePolicySchema>;
export type ScoutBudget = z.infer<typeof ScoutBudgetSchema>;
export type ScoutBrief = z.infer<typeof ScoutBriefSchema>;
export type ScoutReport = z.infer<typeof ScoutReportSchema>;
export type WorkerEffectiveState = z.infer<typeof WorkerEffectiveStateSchema>;
export type ScoutRuntimeState = z.infer<typeof ScoutRuntimeStateSchema>;

export function resolveScoutEffectiveState(
  leasePolicy: WorkerLeasePolicy = "expire-and-discard",
): WorkerEffectiveState {
  return WorkerEffectiveStateSchema.parse({
    lifecycle: "worker",
    profile: "scout",
    tier: 1,
    provider: "cursor",
    model: "composer",
    permissions: "read-only",
    approvalMode: "auto",
    leasePolicy,
  });
}

export function scoutScopeViolation(cwd: string, scope: readonly string[]): string | undefined {
  for (const pattern of scope) {
    if (isAbsolute(pattern) || pattern.startsWith("!")) {
      return `Scout scope must be a relative path/glob allowlist entry: ${pattern}`;
    }
    const path = relative(resolve(cwd), resolve(cwd, pattern));
    if (path === ".." || path.startsWith(`..${sep}`)) {
      return `Scout scope escapes worker cwd: ${pattern}`;
    }
  }
  return undefined;
}
