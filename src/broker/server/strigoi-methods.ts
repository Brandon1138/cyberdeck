import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { StrigoiAdoptionSchema, StrigoiPacketRefSchema, StrigoiSelectionSchema, StrigoiSourceRefSchema, STRIGOI_LIMITS } from "../../domain/strigoi.js";
import type { BrokerMethodHandler } from "./method-context.js";
import type { BrokerServerOptions } from "./options.js";
const mutationId = z.string().min(1).default(() => randomUUID());
const mutation = z.object({ mutationId }).strict();
const actor = z.object({ actorSessionId: z.uuid() });
const requiredMutation = z.string().min(1);
function control(options: BrokerServerOptions) {
  if (!options.strigoi) throw Object.assign(new Error("Strigoi is unavailable"), { code: "METHOD_NOT_FOUND" });
  return options.strigoi;
}
export const strigoiMethods: Record<string, BrokerMethodHandler> = {
  "strigoi.inspect": async (s, _c, f) => { z.object({}).strict().parse(f.params); return control(s.options).inspect(); },
  "strigoi.configure": async (s, _c, f) => {
    const { mutationId: id, ...selection } = StrigoiSelectionSchema.extend({ cwd: z.string().refine(isAbsolute, "cwd must be absolute"), mutationId }).strict().parse(f.params);
    return control(s.options).configure(selection, id);
  },
  ...Object.fromEntries(([ ["suspend", "suspended"], ["resume", "enabled"], ["disable", "disabled"] ] as const).map(([method, desired]) => [
    `strigoi.${method}`, (async (s, _c, f) => control(s.options).desired(desired, mutation.parse(f.params).mutationId)) satisfies BrokerMethodHandler,
  ])),
  "strigoi.renew": async (s, _c, f) => {
    const p = z.object({ expectedIncarnation: z.number().int().positive(), reason: z.string().min(1).default("operator-request"), mutationId }).strict().parse(f.params);
    return control(s.options).renew(p.expectedIncarnation, p.reason, p.mutationId);
  },
  "strigoi.submit": async (s, _c, f) => {
    const p = z.object({ message: z.string().trim().min(1), messageId: mutationId }).strict().parse(f.params);
    return control(s.options).submit(p.message, p.messageId);
  },
  "agent.strigoi.checkpoint": async (s, _c, f) => {
    const p = actor.extend({ prose: z.string().refine(v => Buffer.byteLength(v) <= STRIGOI_LIMITS.checkpointProseBytes), sources: z.array(StrigoiSourceRefSchema).max(STRIGOI_LIMITS.sourceReferencesPerPage).default([]), mutationId: requiredMutation }).strict().parse(f.params);
    return control(s.options).checkpoint(p.actorSessionId, p.prose, p.sources, p.mutationId);
  },
  "agent.strigoi.read": async (s, _c, f) => {
    const p = actor.extend({ packet: StrigoiPacketRefSchema, cursor: z.string().optional() }).strict().parse(f.params);
    return control(s.options).read(p.actorSessionId, p.packet, p.cursor);
  },
  "agent.strigoi.acknowledge": async (s, _c, f) => {
    const { actorSessionId, mutationId, ...adoption } = StrigoiAdoptionSchema.omit({ identity: true }).extend({ actorSessionId: z.uuid(), mutationId: requiredMutation }).strict().parse(f.params);
    return control(s.options).acknowledge(actorSessionId, adoption, mutationId);
  },
  "agent.strigoi.renew": async (s, _c, f) => {
    const p = actor.extend({ reason: z.string().min(1), mutationId: requiredMutation }).strict().parse(f.params);
    return control(s.options).agentRenew(p.actorSessionId, p.reason, p.mutationId);
  },
};
