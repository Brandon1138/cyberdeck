import { z } from "zod";

export const WorkerPreferencesSchema = z.object({
  caveman: z.boolean().default(false),
});

export type WorkerPreferences = z.infer<typeof WorkerPreferencesSchema>;
