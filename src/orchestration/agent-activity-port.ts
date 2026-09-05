import type { ActivityInput, AgentActivity } from "../domain/agent-activity.js";
export interface AgentActivityPort {
  append(event: ActivityInput): Promise<AgentActivity>;
  read(runId: string, afterSequence: number, limit: number): Promise<AgentActivity[]>;
  pin?(runId: string, pinned: boolean): Promise<void>;
  close?(): Promise<void>;
  health(): { degraded: boolean; dropped: number; retained: number };
}
