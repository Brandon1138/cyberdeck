import type { AgentActivity } from "../domain/agent-activity.js";
import type { AgentActivityPort } from "./agent-activity-port.js";
export interface ActivitySinkPort { record(event: AgentActivity): void; health(): unknown }
/** Only acknowledged local records flow downstream; export cannot change their durability. */
export function withActivitySink(local: AgentActivityPort, sink?: ActivitySinkPort): AgentActivityPort {
  return { ...(local.pin ? { pin: (run: string, pinned: boolean) => local.pin!(run, pinned) } : {}),
    ...(local.readSession ? { readSession: (session: string, after: number, limit: number) => local.readSession!(session, after, limit) } : {}),
    ...(local.noteGap ? { noteGap: () => local.noteGap!() } : {}),
    ...(local.close ? { close: () => local.close!() } : {}), read: (run, after, limit) => local.read(run, after, limit), health: () => local.health(),
    append: async (input) => {
      const event = await local.append(input);
      try { sink?.record(event); } catch { /* sink health is separate from local capture */ }
      return event;
    },
  };
}
