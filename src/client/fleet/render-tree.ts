import type { FleetTreeRow } from "./list-rows.js";
import { threadFocusInert } from "./list-rows.js";
import type { FleetState, FleetThread } from "./state.js";
import type { ResolvedFleetRenderOptions } from "./runtime-options.js";
import { fit, pad } from "./render-composer.js";
import { rowGutter } from "./render-rows.js";
import { paint, shortPath, statusText } from "./slash-commands.js";
import { threadStatus } from "./transport.js";
import { compactThreadIdentity } from "./model-labels.js";
import { isUnreadThread } from "./visit-state.js";
import type { LeaseCustodyBadge } from "../lease-custody.js";
import { displayWidth } from "../display-width.js";
import { isHandoffMarked } from "./picker-handoff.js";
import { pullRequestLabel, pullRequestTone } from "../pr-status.js";

const indentation = (tree: FleetTreeRow) => "  ".repeat(Math.min(tree.depth, 3));

export function renderTreeFolder(cwd: string, heading: string | undefined, collapsed: boolean,
  tree: FleetTreeRow, state: FleetState, options: ResolvedFleetRenderOptions, scrollbar?: "track" | "thumb"): string {
  const focused = state.focusedFolderCwd === cwd;
  const width = Math.max(1, options.width - 2);
  const name = heading === cwd ? shortPath(cwd, options.home) : heading ?? cwd;
  const label = `${indentation(tree)}${collapsed ? "▸" : "▾"} ${name}`;
  // Preserve a meaningful heading before spending space on the rollup.
  const room = Math.max(0, width - Math.min(displayWidth(label), Math.max(24, Math.floor(width * .55))) - 3);
  const summary = tree.summary ? fit(tree.summary, room) : "";
  const text = summary ? `${fit(label, width - displayWidth(summary) - 3)} · ${summary}` : fit(label, width);
  return `${rowGutter(focused, options.color, scrollbar)}${paint(text, focused ? "bold" : "muted", options.color)}`;
}

/** Narrow trees spend width on task and status; the selected detail owns full model/parent metadata. */
export function renderTreeThread(thread: FleetThread, tree: FleetTreeRow, state: FleetState,
  options: ResolvedFleetRenderOptions, scrollbar?: "track" | "thumb", custody?: LeaseCustodyBadge): string {
  const selected = !threadFocusInert(state) && thread.record.id === state.selectedSessionId;
  const role = thread.record.kind === "orchestrator" ? "ORC" : thread.nativeAgent ? "native" : "managed";
  const disclosure = tree.key ? tree.collapsed ? "▸" : "▾" : "·";
  const prefix = `${indentation(tree)}${disclosure} ${role} `;
  const marker = `${isUnreadThread(state, thread.record.id) ? "* " : ""}${thread.record.pinned ? "⌃ " : ""}`;
  const name = thread.record.name ?? thread.record.role ?? thread.record.id.slice(0, 8);
  const title = `${marker}${name}`;
  const status = threadStatus(thread);
  const pr = options.pullRequests.get(thread.record.id);
  const right = [status, custody?.label, options.width >= 100 ? compactThreadIdentity(thread.record) : undefined].filter(Boolean).join(" · ");
  const available = Math.max(1, options.width - 2);
  const prLabel = pr && options.width >= 80 ? pullRequestLabel(pr) : "";
  const prWidth = prLabel ? displayWidth(prLabel) + 1 : 0;
  const rightWidth = Math.min(displayWidth(right), Math.max(0, available - displayWidth(prefix) - 8 - prWidth));
  const leftWidth = Math.max(1, available - rightWidth - 1 - prWidth);
  const left = pad(fit(`${prefix}${title}`, leftWidth), leftWidth);
  return `${rowGutter(selected, options.color, scrollbar, isHandoffMarked(state, thread.record.id))}${paint(left, selected ? "bold" : "muted", options.color)} ${statusText(fit(right, rightWidth), false, options.color)}${prLabel ? ` ${paint(prLabel, pullRequestTone(pr!.state), options.color)}` : ""}`;
}
