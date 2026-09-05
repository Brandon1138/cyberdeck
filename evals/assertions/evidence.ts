import { z } from "zod";
import { scenarioIds } from "../scenarios/catalog.js";
export const ScenarioEvidenceSchema = z.object({
  schemaVersion: z.literal(1), runId: z.uuid(), scenarioId: z.enum(scenarioIds as [string, ...string[]]),
  scenarioVersion: z.literal(1), mode: z.enum(["offline-scripted", "live-container"]),
  status: z.enum(["completed", "failed", "timed-out"]), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  commit: z.string().regex(/^[a-f0-9]{40}$/), dirtyImplementation: z.boolean(), brokerId: z.uuid().nullable(),
  provider: z.string().min(1), providerVersion: z.string().min(1), model: z.string().min(1),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  captureComplete: z.boolean(), requiredCommandCoverage: z.boolean(), commandCoverage: z.enum(["scripted", "provider-native", "unavailable"]),
  expectedChangedPaths: z.array(z.string()), actualChangedPaths: z.array(z.string()), reportedChangedPaths: z.array(z.string()),
  unrelatedPathsChanged: z.array(z.string()), unauthorizedMutationCount: z.number().int().nonnegative(),
  missingInstructionIds: z.array(z.string()), harnessErrors: z.array(z.string()),
  checks: z.array(z.object({ name: z.string(), passed: z.boolean(), provenance: z.enum(["broker", "host-verified", "scripted", "provider-native"]), evidenceRefs: z.array(z.string()).min(1) }).strict()),
  artifacts: z.array(z.object({ id: z.string().min(1), path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1),
  cleanup: z.enum(["complete", "retained-failure"]),
  spend: z.object({ measuredUsd: z.number().nonnegative().nullable(), authorizedCeilingUsd: z.number().nonnegative().nullable() }).strict(),
}).strict();
export type ScenarioEvidence = z.infer<typeof ScenarioEvidenceSchema>;
