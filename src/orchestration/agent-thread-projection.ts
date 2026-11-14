import type { SessionRecord } from "../domain/session.js";
import type { WorkerTruth } from "../domain/worker-truth.js";
import type { ThreadStatusRecord } from "./agent-control-service.js";
import { THREAD_PREVIEW_CHARS } from "../limits.js";

/** Everything a liveness or duplicate-safety check needs, and nothing that grows with transcript size. */
export function statusRecord(record: SessionRecord, truth: WorkerTruth | undefined): ThreadStatusRecord {
  return {
    id: record.id,
    ...(record.name === undefined ? {} : { name: record.name }),
    provider: record.provider,
    executionState: record.executionState,
    ...(record.attentionState === undefined ? {} : { attentionState: record.attentionState }),
    ...(truth === undefined ? {} : { truth }),
    ...(record.termination === undefined ? {} : { termination: record.termination }),
  };
}

/**
 * The full view still has to fit a caller's token budget. `latestPreview` is the field that made a
 * 19-thread listing 55k characters, and `launchRecord` is spawn forensics no lister asked for.
 */
export function boundedRecord(record: SessionRecord): SessionRecord {
  const { launchRecord: _launchRecord, ...rest } = record;
  return {
    ...rest,
    ...(record.latestPreview === undefined
      ? {}
      : { latestPreview: truncatePreview(record.latestPreview) }),
  };
}

function truncatePreview(preview: string): string {
  return preview.length <= THREAD_PREVIEW_CHARS
    ? preview
    : `${preview.slice(0, THREAD_PREVIEW_CHARS - 1)}…`;
}

