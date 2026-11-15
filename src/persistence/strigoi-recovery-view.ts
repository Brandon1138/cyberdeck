import { InstructionRecordSchema, type InstructionRecord } from "../domain/instruction.js";
import { ThreadEventSchema } from "../domain/thread.js";
import { recoveryCheckpoint } from "../domain/strigoi-recovery.js";
import type { StrigoiSourceRef, StrigoiState } from "../domain/strigoi.js";

type Original = { refs: StrigoiSourceRef[]; text: string; value: unknown };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const instructionKey = (r: InstructionRecord) => JSON.stringify([r.id, r.message, r.actorSessionId, r.senderSessionId, r.targetSessionId, r.messageId]);

/** A model-facing selection, never an archive rewrite, delivery decision or coverage receipt. */
export function recoveryView(sources: StrigoiSourceRef[], state: StrigoiState) {
  const checkpoint = recoveryCheckpoint(state);
  const available = new Set(sources.map(s => s.coverageSourceId));
  // A base whose covered originals are missing cannot silently replace them.
  const useBase = checkpoint.receipt && [...checkpoint.handled].every(id => available.has(id));
  const handled = useBase ? checkpoint.handled : new Set<string>();
  const grouped = new Map<string, StrigoiSourceRef[]>();
  for (const source of sources) {
    const key = JSON.stringify([source.kind, source.id, source.revision, source.sha256]);
    const group = grouped.get(key) ?? []; group.push(source); grouped.set(key, group);
  }
  const originals: Original[] = [...grouped.values()].map(refs => {
    refs.sort((a, b) => a.part! - b.part!);
    const text = refs.map(r => r.text ?? "").join("");
    let value: unknown; try { value = JSON.parse(text); } catch { /* Unknown formats stay visible. */ }
    return { refs, text, value };
  });
  const internalTexts = new Set<string>();
  const internalTurns = new Set<string>();
  for (const original of originals) {
    if (!original.refs[0]!.id.startsWith("thread:")) continue;
    const parsed = ThreadEventSchema.safeParse(original.value);
    if (parsed.success && parsed.data.source === "broker" && ["adoption", "checkpoint"].includes(String(parsed.data.data.successionKind))) {
      if (parsed.data.text) internalTexts.add(parsed.data.text);
      if (typeof parsed.data.data.expectedTurn === "number") internalTurns.add(`${parsed.data.sessionId}:${parsed.data.data.expectedTurn}`);
    }
  }
  for (const original of originals) {
    if (!original.refs[0]!.id.startsWith("thread:")) continue;
    const parsed = ThreadEventSchema.safeParse(original.value);
    if (parsed.success && parsed.data.kind === "turn" && internalTurns.has(`${parsed.data.sessionId}:${parsed.data.data.turnNumber}`)
      && parsed.data.text) internalTexts.add(parsed.data.text);
  }
  // Repeated queue observations are state revisions, not distinct user commitments.
  // Keep different messages even if their instruction ID was reused or corrupted.
  const latest = new Map<string, Original>();
  for (const original of originals) {
    if (original.refs[0]!.kind !== "instruction" || original.refs[0]!.id.startsWith("thread:")) continue;
    const parsed = InstructionRecordSchema.safeParse(original.value);
    if (!parsed.success || parsed.data.id !== original.refs[0]!.id) continue;
    const key = instructionKey(parsed.data);
    // Archive observations are ordered; wall-clock timestamps need not be monotonic.
    latest.set(key, original);
  }
  const selected: StrigoiSourceRef[] = [], deferred: Record<string, number> = {};
  const accounting: Record<string, { parts: number; bytes: number }> = {};
  for (const original of originals) {
    const ref = original.refs[0]!, value = object(original.value);
    let reason: string | undefined;
    const category = ref.id.startsWith("native:") ? `native:${String(value?.role)}` : ref.id.startsWith("thread:") ? `thread:${String(value?.kind)}` : ref.kind;
    const count = accounting[category] ??= { parts: 0, bytes: 0 };
    count.parts += original.refs.length; count.bytes += Buffer.byteLength(original.text);
    if (original.refs.every(r => handled.has(r.coverageSourceId!))) reason = "checkpoint-covered";
    else if (ref.id.startsWith("thread:")) {
      const parsed = ThreadEventSchema.safeParse(original.value);
      if (parsed.success) {
        const event = parsed.data;
        if (event.kind === "lifecycle" && event.source === "broker") reason = "runtime-metadata";
        if (event.source === "broker" && ["adoption", "checkpoint"].includes(String(event.data.successionKind))
          || event.kind === "turn" && internalTurns.has(`${event.sessionId}:${event.data.turnNumber}`)) reason = "internal-recovery";
      }
    } else if (ref.id.startsWith("native:") && ["user", "assistant"].includes(String(value?.role)) && internalTexts.has(String(value?.text))) reason = "internal-recovery";
    else if (ref.kind === "instruction") {
      const parsed = InstructionRecordSchema.safeParse(original.value);
      if (parsed.success && parsed.data.id === ref.id && latest.get(instructionKey(parsed.data)) !== original) reason = "older-instruction-revision";
    }
    if (reason) deferred[reason] = (deferred[reason] ?? 0) + original.refs.length;
    else selected.push(...original.refs);
  }
  return {
    sources: selected,
    checkpoint: useBase ? { mutationId: checkpoint.receipt!.mutationId, account: checkpoint.receipt!.adoption!.account } : undefined,
    recovery: { version: 1 as const, ...(useBase ? { baseMutationId: checkpoint.receipt!.mutationId } : {}) },
    accounting: { categories: accounting, deferred, totalParts: sources.length, selectedParts: selected.length,
      originalBytes: sources.reduce((n, s) => n + Buffer.byteLength(s.text ?? ""), 0),
      selectedBytes: selected.reduce((n, s) => n + Buffer.byteLength(s.text ?? ""), 0) },
  };
}
