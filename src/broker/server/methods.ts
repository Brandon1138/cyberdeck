import { activityMethods } from "./activity-methods.js";
import { agentMethods } from "./agent-methods.js";
import { fleetMethods } from "./fleet-methods.js";
import { jobMethods } from "./job-methods.js";
import type { BrokerMethodHandler } from "./method-context.js";
import { sessionMethods } from "./session-methods.js";

/**
 * Every method the broker answers, in one table.
 *
 * The groups are disjoint by construction — a duplicate key would silently shadow, so the table is
 * assembled once here rather than merged per call.
 */
export const BROKER_METHODS: Record<string, BrokerMethodHandler> = Object.assign(
  Object.create(null) as Record<string, BrokerMethodHandler>,
  activityMethods,
  sessionMethods,
  agentMethods,
  fleetMethods,
  jobMethods,
);
