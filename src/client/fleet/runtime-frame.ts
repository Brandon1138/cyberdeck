import { fallbackWorkerCapabilities, type ResolvedWorkerCapability } from "../../orchestration/worker-capabilities.js";
import { displayWidth } from "../display-width.js";
import { pullRequestLabel } from "../pr-status.js";
import { PULL_REQUEST_CELL_WIDTH, WORKTREE_TAG_WIDTH, workerModelCatalog } from "./constants.js";
import { fleetListRows, orderedThreads } from "./list-rows.js";
import { handoffRecipients } from "./picker-handoff.js";
import { existingOrchestrators } from "./picker-orchestrator.js";
import { commandPaletteCandidates } from "./picker-palette.js";
import { pickerModelChoices, pickerScrollOffset } from "./picker-worker.js";
import { renderComposerLines } from "./render-composer.js";
import { renderFleetFooter, renderHeader, renderShellTranscript, shellTranscriptScrollOffset } from "./render-list.js";
import { ResolvedFleetRenderOptions, WorkerModelCatalog } from "./runtime-options.js";
import { FleetSnapshot, FleetState, InteractiveFleetTransport } from "./state.js";

export async function readWorkerModels(client: InteractiveFleetTransport): Promise<WorkerModelCatalog> {
  const [workers, orchestrators] = await Promise.all([
    readCapabilities(client, "worker.capabilities"),
    readCapabilities(client, "orchestrator.capabilities"),
  ]);
  return workerModelCatalog(workers, orchestrators);
}

async function readCapabilities(
  client: InteractiveFleetTransport,
  method: "worker.capabilities" | "orchestrator.capabilities",
): Promise<readonly ResolvedWorkerCapability[]> {
  try {
    return await client.request<readonly ResolvedWorkerCapability[]>(method, {});
  } catch (error) {
    return fallbackWorkerCapabilities(
      `Fleet could not read ${method} from the broker: ${error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Preview polling is the only background repaint source; one sample per interval coalesces it. */
export const PREVIEW_REPAINT_INTERVAL_MS = 100;

export interface FleetFrameLayout {
  width: number;
  height: number;
  /** Names the viewport position independently of the rows currently occupying it. */
  scrollOffset: string;
  /** Stable while the same kinds of rows occupy the same terminal positions. */
  topology: string;
}

export interface RetainedFleetFrame extends FleetFrameLayout {
  rows: readonly string[];
  cursor: { row: number; column: number; } | undefined;
}

/**
 * Structural identity for the rendered Fleet surface.
 *
 * Content such as a preview, age, status, selection, or draft is deliberately absent: those are
 * row damage. Row insertion/reordering, footer growth, picker changes, or a column appearing alter
 * where later content lives and therefore force a complete in-place repaint.
 */
export function fleetFrameLayout(
  snapshot: FleetSnapshot,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): FleetFrameLayout {
  const frame = (topology: unknown, scrollOffset: string): FleetFrameLayout => ({
    width: options.width,
    height: options.height,
    scrollOffset,
    topology: JSON.stringify(topology),
  });
  const sessionIds = orderedThreads(snapshot).map(({ record }) => record.id);
  const noticeRows = state.notice === undefined ? 0 : 1;

  if (state.workerPicker !== undefined) {
    const picker = state.workerPicker;
    const choices = pickerModelChoices(state);
    const fallbackRows = state.workerModels.fallbacks.length
      + (state.workerModels.fallbacks.length === 0 ? 0 : 1);
    const modelPreludeRows = renderHeader([], state, options).length + 3 + fallbackRows;
    const visibleModelRows = Math.max(1, options.height - 3 - modelPreludeRows);
    const modelScrollOffset = picker.step === "model"
      ? pickerScrollOffset(picker.modelIndex, choices.length, visibleModelRows)
      : 0;
    return frame({
      surface: "worker-picker",
      step: picker.step,
      sessions: sessionIds,
      choices: choices.map(({ provider, model }) => `${provider}:${model}`),
      fallbackCount: state.workerModels.fallbacks.length,
      preludeRows: modelPreludeRows,
      footerRows: 3,
    }, `worker-picker:${picker.step}:${modelScrollOffset}`);
  }
  if (state.permissionPicker !== undefined) {
    return frame({
      surface: "permission-picker",
      step: state.permissionPicker.step,
      sessions: sessionIds,
      footerRows: 2 + noticeRows,
    }, `permission-picker:${state.permissionPicker.step}`);
  }
  if (state.commandPalette !== undefined) {
    const composerRows = renderComposerLines(state.draft, "task", options).length;
    return frame({
      surface: "command-palette",
      level: state.commandPalette.level,
      candidates: commandPaletteCandidates(state),
      footerRows: composerRows + 3,
    }, `command-palette:${state.commandPalette.scrollOffset}`);
  }
  if (state.handoffPicker !== undefined) {
    return frame({
      surface: "handoff-picker",
      step: state.handoffPicker.step,
      workers: state.handoffPicker.workerIds,
      recipients: handoffRecipients(snapshot, state.handoffPicker.workerIds).map(({ id }) => id),
      footerRows: 2 + noticeRows,
    }, `handoff-picker:${state.handoffPicker.step}`);
  }
  if (state.orchestratorPicker !== undefined) {
    return frame({
      surface: "orchestrator-picker",
      step: state.orchestratorPicker.step,
      choices: state.workerModels.orchestratorChoices.map(({ provider, model }) =>
        [provider.provider, model, provider.efforts, provider.fallbackReason]),
      sessions: existingOrchestrators(snapshot).map(({ id }) => id),
      footerRows: 2 + noticeRows + (state.orchestratorPicker.step === "effort" ? 1 : 0),
    }, `orchestrator-picker:${state.orchestratorPicker.step}`);
  }

  const threads = orderedThreads(snapshot);
  const rows = fleetListRows(snapshot, state);
  const pullRequestWidth = threads.reduce((widest, { record }) => {
    const summary = options.pullRequests.get(record.id);
    return summary === undefined
      ? widest
      : Math.max(widest, Math.min(PULL_REQUEST_CELL_WIDTH, pullRequestLabel(summary).length));
  }, 0);
  const leaseBadgeWidth = rows.reduce(
    (widest, row) => row.kind === "thread" && row.leaseBadge !== undefined
      ? Math.max(widest, row.leaseBadge.label.length)
      : widest,
    0,
  );
  const worktreeWidth = rows.reduce(
    (widest, row) => row.kind === "thread" && row.worktree !== undefined
      ? Math.max(widest, Math.min(WORKTREE_TAG_WIDTH, row.worktree.length))
      : widest,
    0,
  );
  const ownerSigilWidth = rows.reduce(
    (widest, row) => row.kind === "thread" && row.ownerSigil !== undefined
      ? Math.max(widest, displayWidth(row.ownerSigil))
      : widest,
    0,
  );
  const footerHeight = renderFleetFooter(snapshot, state, options).length;
  const headerHeight = renderHeader(threads, state, options).length + 1;
  const bodyHeight = Math.max(0, options.height - footerHeight);
  const viewportHeight = Math.max(0, bodyHeight - headerHeight);
  const shellTranscript = state.shellMode === undefined
    ? undefined
    : renderShellTranscript(state.shellMode, viewportHeight, options);
  const rowKeys = state.shellMode === undefined
    ? rows.map((row) => {
      if (row.kind === "folder") return `folder:${row.cwd}`;
      if (row.kind === "thread") return `thread:${row.thread.record.id}`;
      if (row.kind === "show-more") return `show-more:${row.cwd}`;
      if (row.kind === "ownership") return `ownership:${row.coordination.sessionId}`;
      return row.kind;
    })
    : [`shell:${shellTranscript!.length}`];

  return frame({
    surface: state.shellMode === undefined ? "fleet-list" : "shell",
    headerHeight,
    footerHeight,
    rows: rowKeys,
    columns: [pullRequestWidth, leaseBadgeWidth, worktreeWidth, ownerSigilWidth],
  }, state.shellMode === undefined
    ? `fleet-list:${state.threadListScrollOffset}`
    : `shell:${shellTranscriptScrollOffset(state.shellMode, viewportHeight)}`);
}
