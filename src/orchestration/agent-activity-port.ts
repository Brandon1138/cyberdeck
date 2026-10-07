import type { ActivityInput, AgentActivity } from "../domain/agent-activity.js";
export interface ActivityReplayBounds {
  sourceId: string; firstSequence: number | null; sequence: number; captureGaps: number; uncertain: boolean;
}
export interface AgentActivityPort {
  append(event: ActivityInput): Promise<AgentActivity>;
  read(runId: string, afterSequence: number, limit: number): Promise<AgentActivity[]>;
  readSession?(sessionId: string, afterSequence: number, limit: number): Promise<AgentActivity[]>;
  noteGap?(): Promise<void>;
  pin?(runId: string, pinned: boolean): Promise<void>;
  close?(): Promise<void>;
  readGlobal?(afterSequence: number, limit: number): Promise<AgentActivity[]>;
  replayBounds?(): ActivityReplayBounds;
  /** Retain all events strictly after the durable consumer checkpoint. */
  retainAfter?(consumer: string, sequence: number): Promise<void>;
  health(): { degraded: boolean; dropped: number; retained: number };
}
