import type { AgentActivity } from "../domain/agent-activity.js";
import type { AgentActivityPort } from "./agent-activity-port.js";
export interface ActivitySinkPort { record(event: AgentActivity): void; health(): unknown }
/** Only acknowledged local records flow downstream; export cannot change their durability. */
export function withActivitySink(local: AgentActivityPort, sink?: ActivitySinkPort): AgentActivityPort {
  return { read: (run, after, limit) => local.read(run, after, limit), health: () => local.health(),
    append: async (input) => {
      const event = await local.append(input);
      try { sink?.record(event); } catch { /* sink health is separate from local capture */ }
      return event;
    },
  };
}
