import { z } from "zod";
import type { ResourceDemand, ResourceSample } from "../../domain/resource-budget.js";
import type { ResourceRuntimeIdentity } from "../../domain/resource-runtime.js";
import type { WorkspaceFileFact } from "./workspace-manifest.js";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const NativeToolRequestSchema = z.object({ requestId: id, attemptId: id,
  executionId: id, generation: z.number().int().positive(), recipeId: id }).strict();
export type NativeToolRequest = z.infer<typeof NativeToolRequestSchema>;
/** This object comes from canonical broker authority, NEVER from the requesting worker. */
export interface NativeToolAuthorization {
  familyId: string;
  writeAllowed: boolean;
  workspaceRoot: string;
  inputManifest: WorkspaceFileFact[];
}
/** Recipes are installed by the operator, including the hash of all trusted source/project inputs.
 * Xcode project files and build scripts are code: no arbitrary worker project is implicitly trusted. */
export interface NativeToolRecipe {
  id: string;
  inputManifestSha256: string;
  project: string;
  scheme: string;
  developerDirectory: string;
  /** Runtime and device type are broker-pinned; a fresh simulator UUID is created per attempt. */
  simulatorRuntime: string;
  simulatorDeviceType: string;
  action: "build" | "test";
  timeoutMs: number;
  maxInputBytes: number;
  maxArtifactBytes: number;
  demand: ResourceDemand;
}
export interface NativeCommand {
  executable: string; args: string[]; cwd: string; env: Record<string, string>;
  timeoutMs: number; logPath: string; maxArtifactBytes: number; artifactsDirectory: string;
  memoryBytes: number; pidLimit: number;
}
export interface NativeCommandResult {
  exitCode: number | null; signal: string | null; timedOut: boolean; cancelled: boolean;
  reason: string | null;
  identities: ResourceRuntimeIdentity[];
  cleanup: "terminated" | "unproven";
  uncertainty: string[];
}
export interface NativeProcessSupervisor {
  run(command: NativeCommand, context: { signal?: AbortSignal;
    identities: (identities: ResourceRuntimeIdentity[]) => Promise<void>;
    sample?: (sample: Omit<ResourceSample, "owner">) => void;
  }): Promise<NativeCommandResult>;
}
