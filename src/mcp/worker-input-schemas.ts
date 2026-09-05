export function workerBudgetInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    description:
      "Optional broker-owned worker allowance. Measurements may be approximate or stale; "
      + "Cyberdeck owns soft wrap-up and hard stop enforcement.",
    properties: {
      schemaVersion: { type: "integer", const: 1, default: 1 },
      resource: { type: "string", enum: ["weekly", "session"] },
      allocation: {
        type: "object",
        properties: {
          unit: { type: "string", enum: ["percent", "tokens", "wall-clock-ms"] },
          amount: { type: "number", exclusiveMinimum: 0 },
        },
        required: ["unit", "amount"],
        allOf: [{
          if: {
            properties: { unit: { const: "percent" } },
            required: ["unit"],
          },
          then: { properties: { amount: { maximum: 100 } } },
        }],
        additionalProperties: false,
      },
      policy: {
        type: "object",
        properties: {
          softLimitRatio: {
            type: "number",
            exclusiveMinimum: 0,
            exclusiveMaximum: 1,
            default: 0.8,
          },
          hardLimitRatio: { type: "number", const: 1, default: 1 },
          softAction: { type: "string", const: "wrap-up", default: "wrap-up" },
          hardAction: { type: "string", const: "stop", default: "stop" },
        },
        additionalProperties: false,
      },
    },
    required: ["resource", "allocation"],
    additionalProperties: false,
  };
}

/** Typed worker workspace, mirroring `WorkerWorkspaceSchema`. */
export function workerWorkspaceInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    description:
      "Where this worker's work lives. Declaring it lets Cyberdeck validate the worktree, branch, "
      + "and base before the worker starts, grant the writable roots its provisioning mode needs, "
      + "and — with provisioning cyberdeck-provisioned — create the worktree itself so no "
      + "orchestrator has to shell out to `git worktree add`.",
    properties: {
      worktreePath: {
        type: "string",
        description:
          "Absolute path of the worktree the worker runs in. Required unless provisioning is "
          + "cyberdeck-provisioned, where omitting it lets Cyberdeck name the worktree "
          + "<repository>-<branch leaf> beside the repository.",
      },
      branch: { type: "string", description: "Branch the worker's commits land on." },
      baseRef: { type: "string", description: "Ref the branch was cut from and reviews diff against." },
      provisioning: {
        type: "string",
        enum: ["pre-provisioned", "worker-provisioned", "cyberdeck-provisioned"],
        description:
          "cyberdeck-provisioned: Cyberdeck runs `git worktree add` before the worker starts, cwd "
          + "becomes the new worktree, the branch must not already exist, and no extra writable "
          + "roots are needed. pre-provisioned: the worktree already exists and is validated — this "
          + "is also how a worker runs directly in a checkout or branch you already have. "
          + "worker-provisioned: the worker runs `git worktree add` itself, which requires "
          + "workspace-write and the repository's git common directory in writableRoots.",
      },
      repositoryPath: {
        type: "string",
        description:
          "Absolute path of the repository the worktree belongs to. Cyberdeck fills this in when it "
          + "provisions; declaring it is not required.",
      },
      writableRoots: {
        type: "array",
        items: { type: "string" },
        maxItems: 8,
        description: "Absolute directories writable in addition to the worktree.",
      },
    },
    required: ["branch", "baseRef", "provisioning"],
    additionalProperties: false,
  };
}

export function scoutBriefInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      objective: { type: "string", minLength: 1, maxLength: 4_096 },
      hypothesisId: { type: "string", minLength: 1, maxLength: 120 },
      scope: {
        type: "array",
        minItems: 1,
        maxItems: 256,
        items: { type: "string", minLength: 1, maxLength: 4_096 },
      },
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: { type: "string", minLength: 1, maxLength: 4_096 },
      },
      stopCondition: { type: "string", minLength: 1, maxLength: 4_096 },
      budget: {
        type: "object",
        properties: {
          maxWallClockMs: { type: "integer", minimum: 1, maximum: 86_400_000 },
          maxTokens: {
            type: "integer",
            minimum: 1,
            maximum: 10_000_000,
            deprecated: true,
            description: "Deprecated compatibility field; accepted but ignored for termination.",
          },
        },
        required: ["maxWallClockMs"],
        additionalProperties: false,
      },
    },
    required: ["objective", "scope", "questions", "stopCondition"],
    additionalProperties: false,
  };
}

