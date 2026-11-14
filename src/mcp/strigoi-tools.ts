const text = { type: "string", minLength: 1 } as const;
const packet = { type: "object", properties: { artifactId: text, sha256: text, coverageId: text }, required: ["artifactId", "sha256", "coverageId"], additionalProperties: false } as const;
export const STRIGOI_TOOLS = [
  { name: "cyberdeck_strigoi_checkpoint", description: "Current Strigoi only: record continuity evidence using the existing thread.enqueue grant. Keep mutationId stable for retries. Source references request inclusion; they never consume obligations.", inputSchema: {
    type: "object", properties: { prose: { type: "string", description: "At most 32 KiB UTF-8." }, mutationId: text,
      sources: { type: "array", maxItems: 64, items: { type: "object", properties: { kind: { enum: ["turn", "instruction", "worker-event", "attention", "workflow", "artifact"] }, id: text, revision: text, sha256: text }, required: ["kind", "id", "revision"], additionalProperties: false } } },
    required: ["prose", "mutationId"], additionalProperties: false } },
  { name: "cyberdeck_strigoi_read", description: "Current Strigoi only: read a known packet page with thread.read. Follow nextCursor until absent; source text is bounded per page.", inputSchema: {
    type: "object", properties: { packet, cursor: text }, required: ["packet"], additionalProperties: false } },
  { name: "cyberdeck_strigoi_acknowledge", description: "Current Strigoi only: acknowledge exact packet coverage using thread.enqueue. This records understanding, never restores grants or worker ownership. Keep mutationId stable.", inputSchema: {
    type: "object", properties: { packetHash: text, coverageId: text, handledSourceIds: { type: "array", items: text }, account: text, mutationId: text },
    required: ["packetHash", "coverageId", "handledSourceIds", "account", "mutationId"], additionalProperties: false } },
  { name: "cyberdeck_strigoi_renew", description: "Current enabled Strigoi only: request serialized renewal using thread.enqueue. Does not enable, configure, grant authority or bypass a human attachment. Keep mutationId stable.", inputSchema: {
    type: "object", properties: { reason: text, mutationId: text }, required: ["reason", "mutationId"], additionalProperties: false } },
] as const;
export function strigoiToolMethod(name: unknown): string | undefined {
  return STRIGOI_TOOLS.some(t => t.name === name) ? `agent.strigoi.${String(name).slice("cyberdeck_strigoi_".length)}` : undefined;
}
