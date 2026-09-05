import type { ActivityInput, AgentActivity } from "../domain/agent-activity.js";
export interface AgentActivityPort {
  append(event: ActivityInput): Promise<AgentActivity>;
  read(runId: string, afterSequence: number, limit: number): Promise<AgentActivity[]>;
  health(): { degraded: boolean; dropped: number; retained: number };
}
