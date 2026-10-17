import { displayWidth, graphemes, graphemeWidth } from "../display-width.js";
import { workerOwner } from "../owner-sigil.js";
import { threadFocusInert } from "./list-rows.js";
import { fit, elideLeading } from "./render-composer.js";
import { paint, shortPath, statusText } from "./slash-commands.js";
import type { FleetSnapshot, FleetState } from "./state.js";
import type { ResolvedFleetRenderOptions } from "./runtime-options.js";
import { assistantPreview, isUnreadThread } from "./visit-state.js";
import { threadStatus } from "./transport.js";

export function wrapDetailText(value: string, width: number): string[] {
  const lines: string[] = [];
  let line = "", cells = 0;
  for (const cluster of graphemes(value.replace(/\s+/gu, " "))) {
    const size = graphemeWidth(cluster);
    if (cells + size > width && line !== "") {
      const wordBreak = line.lastIndexOf(" ");
      if (wordBreak > 0) { lines.push(line.slice(0, wordBreak)); line = line.slice(wordBreak + 1); cells = displayWidth(line); }
      else { lines.push(line); line = ""; cells = 0; }
    }
    line += cluster; cells += size;
  }
  if (line !== "") lines.push(fit(line, width));
  return lines;
}

/** The explicit reply inspection path is /read or an attachment; cursor traversal never consumes it. */
export function renderSelectedDetail(snapshot: FleetSnapshot, state: FleetState, options: ResolvedFleetRenderOptions, budget: number): string[] {
  if (budget < 2 || threadFocusInert(state) || state.helpOpen === true || state.notice !== undefined
    || state.rename !== undefined || state.projectPrompt !== undefined || state.shellMode !== undefined
    || state.draft.includes("\n") || state.draft.length > options.width) return [];
  const thread = snapshot.threads.find(({ record }) => record.id === state.selectedSessionId);
  if (thread === undefined) return [];
  const record = thread.record;
  const model = record.observedModel?.model ?? record.model ?? "Model unavailable";
  const effort = record.observedModel?.effort ?? record.effort ?? "Provider managed";
  const launchOnly = record.observedModel === undefined || record.observedModel.effort === undefined;
  const owner = record.kind === "orchestrator" ? `controller ${thread.controllerId ?? "unavailable"}`
    : thread.coordination === undefined ? "owner operator"
      : (() => {
        const current = workerOwner(thread.coordination);
        if (current.kind === "unattributed") return "owner unattributed";
        if (current.kind !== "controlled") return "owner none · dispatched by an orchestrator";
        const orc = snapshot.threads.find((entry) => entry.controllerId === current.controllerId);
        return `owner ${orc?.record.name ?? current.controllerId}`;
      })();
  const title = wrapDetailText(record.name ?? record.role ?? "Untitled thread", options.width);
  const identity = wrapDetailText(`${launchOnly ? "~" : ""}${model} · ${effort}`, options.width);
  const path = `cwd ${elideLeading(shortPath(record.cwd, options.home), Math.max(1, options.width - 4))}`;
  const preview = assistantPreview(thread) ?? (isUnreadThread(state, record.id) ? state.replyWatermarks?.[record.id]?.latest : null) ?? "No response yet";
  const status = threadStatus(thread);
  const truth = thread.workerTruth?.detail ?? (status === "Unknown"
    ? "Current provider activity is unavailable on this broker" : record.termination?.reason);
  const metadata = [
    paint(path, "muted", options.color),
    ...(record.workspace?.worktreePath === undefined || record.workspace.worktreePath === record.cwd ? []
      : [paint(fit(`worktree ${shortPath(record.workspace.worktreePath, options.home)}`, options.width), "muted", options.color)]),
    paint(fit(owner, options.width), "subtle", options.color),
    ...(record.kind === "orchestrator" && thread.createdBy !== undefined
      ? [paint(fit(`by ${thread.createdBy.sessionId.slice(0, 8)} · peer creator`, options.width), "subtle", options.color)] : []),
    ...(truth === undefined || status === "Idle" && (thread.workerTruth?.pendingInstructions ?? 0) === 0 || status === "Working" ? []
      : wrapDetailText(`${status}: ${truth}`, options.width).slice(0, 2).map((line) => statusText(line, false, options.color))),
  ];
  const titleRoom = Math.max(1, budget - 2 - identity.length - metadata.length);
  const titleLines = title.slice(0, titleRoom);
  if (titleLines.length < title.length) titleLines[titleLines.length - 1] = fit(`${titleLines.at(-1)}…`, options.width);
  const detail = [
    ...titleLines.map((line) => paint(fit(line, options.width), "bold", options.color)),
    ...identity.map((line) => paint(fit(line, options.width), "subtle", options.color)),
    ...metadata,
  ];
  const visible = detail.slice(0, budget - 2);
  if (status === "Unknown" && truth !== undefined && detail.length > budget - 2 && visible.length > 0) {
    visible[visible.length - 1] = paint(fit(`Unknown: ${truth}`, options.width), "muted", options.color);
  }
  return [paint("─".repeat(options.width), "dim", options.color), ...visible, paint(fit(preview, options.width), "muted", options.color)];
}
