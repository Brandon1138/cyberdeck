import { z } from "zod";
import { ResourceRequestSchema } from "./resource-budget.js";
import type { SessionRecord } from "./session.js";
import type { SessionRuntime } from "./session-runtime.js";

// libproc birth times include microseconds. Coarse ps timestamps cannot fence PID reuse.
export const ResourceRuntimeIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("native"), pid: z.number().int().positive(),
    startTime: z.string().max(64).regex(/^libproc:\d+\.\d{6}$/) }).strict(),
  z.object({ kind: z.literal("container"), containerId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export type ResourceRuntimeIdentity = z.infer<typeof ResourceRuntimeIdentitySchema>;
export const ResourceRuntimeBindingSchema = z.object({
  request: ResourceRequestSchema,
  phase: z.enum(["queued", "reserved", "launching", "bound", "terminated"]),
  identities: z.array(ResourceRuntimeIdentitySchema).max(65536),
}).strict();
export type ResourceRuntimeBinding = z.infer<typeof ResourceRuntimeBindingSchema>;
export interface ResourceRuntimeBindingPort {
  list(): ResourceRuntimeBinding[];
  get(requestId: string): ResourceRuntimeBinding | undefined;
  put(binding: ResourceRuntimeBinding): Promise<void>;
}
export interface ResourceSessionLaunchPort {
  start(record: SessionRecord, launch: () => Promise<SessionRuntime>): Promise<SessionRuntime>;
  cancelStart(sessionId: string): boolean;
}
/** Complete means all descendants/helpers are accounted, including reparented native children. */
export type ResourceRuntimeInspection = {
  state: "running" | "terminated" | "unknown";
  inventoryComplete: boolean;
  identities: ResourceRuntimeIdentity[];
};

export interface ResourceOwnerLockPort {
  assertHeld(): void;
  release(): Promise<void>;
}
