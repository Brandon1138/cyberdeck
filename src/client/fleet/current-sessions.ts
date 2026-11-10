import type { FleetSnapshot, FleetState } from "./state.js";
import type { FleetListRow } from "./list-rows.js";
import { isLiveThread, threadRuntimePresence } from "./runtime-presence.js";

/** Current work is directly discoverable, including observed workers without broker processes. */
export function currentSessionRows(snapshot: FleetSnapshot, state: FleetState): FleetListRow[] {
  const root = state.projectFilter?.replace(/\/$/u, "");
  const threads = snapshot.threads.filter(thread => thread.record.id === state.revealedHistorySessionId
      || threadRuntimePresence(thread) !== "absent" && (!root || thread.record.cwd === root || thread.record.cwd.startsWith(`${root}/`)))
    .sort((a, b) => Number(isLiveThread(b)) - Number(isLiveThread(a))
      || a.record.createdAt.localeCompare(b.record.createdAt) || a.record.id.localeCompare(b.record.id));
  return [
    { kind: "views" },
    ...(root ? [{ kind: "section" as const, label: `Project: ${root} · /filter all to clear` }] : []),
    ...(snapshot.nativeAgentNotice ? [{ kind: "section" as const, label: snapshot.nativeAgentNotice }] : []),
    ...threads.map(thread => ({ kind: "thread" as const, cwd: thread.record.cwd, thread })),
    ...(threads.length === 0 ? [{ kind: "section" as const, label: "No current sessions." }] : []),
  ];
}
