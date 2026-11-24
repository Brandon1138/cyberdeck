import type { SessionRecord } from "../../domain/session.js";
import { orderedThreads } from "./list-rows.js";
import { friendlyModel } from "./model-labels.js";
import { displayThreadName } from "./render-composer.js";
import type { OrchestratorModelChoice } from "./runtime-options.js";
import { paint } from "./slash-commands.js";
import type { FleetSnapshot, OrchestratorPickerFocus } from "./state.js";
import { threadStatus } from "./transport.js";

/** New-orchestrator rows matching what was typed. `modelIndex` stays an index into the full catalog. */
export function visibleOrchestratorModels(
  choices: readonly OrchestratorModelChoice[],
  filter: string,
): readonly { choice: OrchestratorModelChoice; modelIndex: number }[] {
  const needle = filter.trim().toLowerCase();
  if (needle === "") return choices.map((choice, modelIndex) => ({ choice, modelIndex }));
  return choices.flatMap((choice, modelIndex) =>
    `${choice.model} ${choice.label} ${choice.provider.provider} ${choice.provider.label}`
      .toLowerCase()
      .includes(needle)
      ? [{ choice, modelIndex }]
      : []);
}

/**
 * Cursor's effort is the slug. Its catalog effort list is only `native-default`, so the effort
 * step would be a single "Provider managed" row. Codex and Claude keep that step even when a
 * discovered model has no other rung: choosing provider-managed is still an answer there.
 */
export function providerManagedOnly(choice: OrchestratorModelChoice | undefined): boolean {
  const efforts = choice?.provider.efforts ?? [];
  return choice?.provider.provider === "cursor"
    && efforts.length === 1
    && efforts[0] === "native-default";
}

export function orchestratorTargetPosition(
  focus: OrchestratorPickerFocus,
  existing: readonly SessionRecord[],
  visible: readonly { modelIndex: number }[],
): number {
  if (focus.kind === "existing-group") return 0;
  if (focus.kind === "existing") {
    const at = existing.findIndex((record) => record.id === focus.sessionId);
    return at < 0 ? 0 : at + 1;
  }
  const slot = visible.findIndex((row) => row.modelIndex === focus.modelIndex);
  return slot < 0 ? 0 : 1 + existing.length + slot;
}

export function orchestratorTargetFocus(
  index: number,
  existing: readonly SessionRecord[],
  visible: readonly { modelIndex: number }[],
): OrchestratorPickerFocus {
  const record = existing[index];
  if (record !== undefined) return { kind: "existing", sessionId: record.id };
  return { kind: "profile", modelIndex: visible[index - existing.length]?.modelIndex ?? 0 };
}

/** Index among target rows, excluding the disclosure; -1 for that header or a deleted Orc. */
export function orchestratorFocusIndex(
  focus: OrchestratorPickerFocus,
  existing: readonly SessionRecord[],
): number {
  return focus.kind === "profile"
    ? existing.length + focus.modelIndex
    : focus.kind === "existing-group" ? -1
      : existing.findIndex((record) => record.id === focus.sessionId);
}

/** The inverse: the durable focus a row position names, so navigation never stores a position. */
export function orchestratorFocusAt(
  index: number,
  existing: readonly SessionRecord[],
): OrchestratorPickerFocus {
  const record = existing[index];
  return record === undefined
    ? { kind: "profile", modelIndex: Math.max(0, index - existing.length) }
    : { kind: "existing", sessionId: record.id };
}

/**
 * Every orchestrator the broker still holds, live or terminal, in the fleet list's own order.
 *
 * Terminal rows stay until they are deleted, exactly as they do in the fleet list. Filtering them
 * out broke the ctrl+x ladder on the real broker: `SessionRegistry.stop()` moves a live
 * orchestrator to cancelled/stopping on the first press, so the row vanished before the second
 * press could arm the delete and the third could run it. A row that cannot be reached is a row
 * that cannot be cleaned up, so retention is now the whole record set and the label carries the
 * state instead.
 */
export function existingOrchestrators(snapshot: FleetSnapshot): SessionRecord[] {
  return orderedThreads(snapshot)
    .map(({ record }) => record)
    .filter((record) => record.kind === "orchestrator" && record.role === "orchestrator");
}

export function existingOrchestratorLabel(record: SessionRecord, color: boolean): string {
  const name = displayThreadName(
    record.name ?? `${friendlyModel(record.provider, record.model)} orchestrator`,
  );
  const lifecycle = record.attachmentState === "controlled"
    ? paint("in use", "yellow", color)
    : record.executionState === "active"
      ? paint("available", "green", color)
      : record.executionState === "starting"
        ? paint("starting", "green", color)
        // Anything else wears its own outcome rather than a join affordance. A stopped orchestrator
        // sits in this list until it is deleted, and must not read as one waiting to be joined.
        : paint(terminalOrchestratorState(record), "dim", color);
  return `${name}  ${paint(record.id.slice(0, 8), "dim", color)}  ${lifecycle}`;
}

/**
 * The fleet list's own status vocabulary, lowercased for a picker row. Only non-active records
 * reach it, so the `active` branch of {@link threadStatus} — the one that reads the terminal
 * replay — is unreachable and the empty replay below is never consulted.
 */
export function terminalOrchestratorState(record: SessionRecord): string {
  return threadStatus({ record }).toLowerCase();
}
