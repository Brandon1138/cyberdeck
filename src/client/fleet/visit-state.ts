import { conversationPreview } from "../../domain/conversation-preview.js";
import type { FleetReplyWatermark, FleetVisitPreferences } from "../../domain/fleet-preferences.js";
import type { FleetSnapshot, FleetState, FleetThread, FolderDisposition } from "./state.js";
import { groupThreads } from "./list-groups.js";
import { threadStatus } from "./transport.js";

export function restoreVisitPreferences(state: FleetState, snapshot: FleetSnapshot, preferences: FleetVisitPreferences, folders: Readonly<Record<string, FolderDisposition>>): FleetState {
  const view = preferences.view ?? "live";
  return { ...state, listView: view, replyWatermarks: preferences.replies,
    focusedViewControl: state.focusedViewControl === undefined ? undefined : view,
    ...(view === "history" ? { expandedHistoryCwds: ["/@orcs", ...groupThreads(snapshot).map(({ cwd }) => cwd)]
      .filter((cwd) => folders[cwd]?.historyExpanded !== false) } : {}),
  };
}

/** Presentation membership only. Activity and verified task outcome remain broker-owned. */
export function isLiveThread(thread: FleetThread): boolean {
  const status = threadStatus(thread);
  if ((thread.workerTruth?.pendingInstructions ?? 0) > 0) return true;
  if (status === "Idle") return false;
  if (status === "Done") return false;
  if (status === "Stopped" || status === "Exited") {
    // A contradictory live process must remain inspectable ahead of history.
    return typeof thread.record.exitCode !== "number"
      || thread.record.executionState === "active" || thread.record.executionState === "starting";
  }
  // Failed, interrupted, uncertain, limited and blocked sessions all need an operator's attention.
  return true;
}

export function assistantPreview(thread: FleetThread): string | null {
  if (thread.record.latestPreviewKind === "prompt" || thread.record.latestPreviewKind === "none") return null;
  const preview = conversationPreview({ storedPreview: thread.record.latestPreview });
  return preview.kind === "assistant" ? preview.text : null;
}

/**
 * latestPreview can contain a legacy prompt/replay fallback. Require native assistant turn evidence
 * before advertising a reply. meaningfulUpdatedAt includes prompts and lifecycle changes; it is
 * only a sorting hint after BOTH content and canonical turn evidence advance.
 */
export function reconcileReplyWatermarks(state: FleetState, snapshot: FleetSnapshot): FleetState {
  let replies = state.replyWatermarks ?? {};
  let changed = false;
  for (const thread of snapshot.threads) {
    const id = thread.record.id;
    const previous = replies[id];
    const turns = thread.workerTruth?.canonicalTurns ?? 0;
    const generation = thread.record.generation;
    const currentPreview = assistantPreview(thread);
    const preview = turns > 0 && thread.record.latestPreviewKind === "assistant" ? currentPreview : null;
    const staleGeneration = generation !== undefined && previous?.generation !== undefined && generation < previous.generation;
    let next: FleetReplyWatermark | undefined;
    if (previous === undefined) {
      // First sight is a baseline, never a claim that historical prose is new.
      next = { seen: currentPreview, latest: currentPreview, canonicalTurns: turns, seenCanonicalTurns: turns,
        ...(generation === undefined ? {} : { generation, seenGeneration: generation }) };
    } else if (!staleGeneration && previous.canonicalTurns === 0 && previous.latest !== null
      && previous.latest === previous.seen && preview !== null) {
      // A cold index can precede native ledger restoration. Its first trusted capture is another
      // baseline, not evidence that historical prose was sent after this operator arrived.
      next = { seen: preview, latest: preview, canonicalTurns: turns, seenCanonicalTurns: turns,
        ...(generation === undefined ? {} : { generation, seenGeneration: generation }) };
    } else if (!staleGeneration
      && (turns > previous.canonicalTurns
      || generation !== undefined && previous.generation !== undefined && generation > previous.generation && turns > 0)
      && preview !== null && preview !== previous.latest) {
      next = {
        ...previous,
        seenCanonicalTurns: previous.seenCanonicalTurns ?? previous.canonicalTurns,
        ...(previous.seenGeneration === undefined && previous.generation !== undefined ? { seenGeneration: previous.generation } : {}),
        latest: preview,
        canonicalTurns: turns,
        ...(generation === undefined ? {} : { generation }),
        ...(thread.record.meaningfulUpdatedAt === undefined ? {} : { updatedAt: thread.record.meaningfulUpdatedAt }),
      };
    }
    if (next !== undefined) {
      if (!changed) replies = { ...replies };
      changed = true;
      (replies as Record<string, FleetReplyWatermark>)[id] = next;
    }
  }
  return changed ? { ...state, replyWatermarks: replies } : state;
}

export function isUnreadThread(state: FleetState, sessionId: string): boolean {
  const watermark = state.replyWatermarks?.[sessionId];
  return watermark !== undefined && watermark.latest !== null && (watermark.latest !== watermark.seen
    || watermark.canonicalTurns > (watermark.seenCanonicalTurns ?? watermark.canonicalTurns)
    || (watermark.generation ?? 0) > (watermark.seenGeneration ?? watermark.generation ?? 0));
}

export function markThreadRead(state: FleetState, sessionId: string): FleetState {
  const watermark = state.replyWatermarks?.[sessionId];
  if (watermark === undefined || !isUnreadThread(state, sessionId)) return state;
  return {
    ...state,
    replyWatermarks: { ...state.replyWatermarks, [sessionId]: { ...watermark, seen: watermark.latest,
      seenCanonicalTurns: watermark.canonicalTurns, ...(watermark.generation === undefined ? {} : { seenGeneration: watermark.generation }) } },
  };
}

export function unreadThreads(snapshot: FleetSnapshot, state: FleetState): FleetThread[] {
  return snapshot.threads.filter(({ record }) => isUnreadThread(state, record.id)).sort((left, right) => {
    const leftAt = state.replyWatermarks?.[left.record.id]?.updatedAt ?? "";
    const rightAt = state.replyWatermarks?.[right.record.id]?.updatedAt ?? "";
    return rightAt.localeCompare(leftAt) || left.record.id.localeCompare(right.record.id);
  });
}
