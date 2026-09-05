import { z } from "zod";
import type { BrokerMethodHandler } from "./method-context.js";
const ReadSchema = z.object({ runId: z.uuid(), afterSequence: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(1000).default(100) }).strict();
export const activityMethods: Record<string, BrokerMethodHandler> = {
  "activity.read": async (server, _context, frame) => {
    const input = ReadSchema.parse(frame.params), activity = server.options.activity;
    if (!activity) throw new Error("ACTIVITY_CAPTURE_UNAVAILABLE");
    return { events: await activity.read(input.runId, input.afterSequence, input.limit), health: activity.health() };
  },
  "activity.pin": async (server, _context, frame) => {
    const input = z.object({ runId: z.uuid(), pinned: z.boolean() }).strict().parse(frame.params);
    if (!server.options.activity?.pin) throw new Error("ACTIVITY_PIN_UNAVAILABLE");
    await server.options.activity.pin(input.runId, input.pinned);
    return { runId: input.runId, pinned: input.pinned };
  },
  "execution.health": async (server) => server.options.executionHealth?.() ?? { configured: false },
  "telemetry.health": async (server) => server.options.telemetry?.health() ?? { enabled: false },
  "activity.health": async (server) => server.options.activity?.health() ?? { degraded: true, dropped: 0, retained: 0 },
};
