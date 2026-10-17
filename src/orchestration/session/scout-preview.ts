import type { SessionRecord } from "../../domain/session.js";

/** Keep structured assistant findings distinct from supervisor-generated failure diagnostics. */
export function setScoutPreview(record: SessionRecord, text: string, kind: "assistant" | "none"): boolean {
  const preview = text.slice(0, 600);
  const changed = record.latestPreview !== preview || record.latestPreviewKind !== kind;
  record.latestPreview = preview;
  record.latestPreviewKind = kind;
  return changed;
}
