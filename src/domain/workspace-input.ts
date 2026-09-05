import { z } from "zod";
const path = z.string().min(1).max(1024).refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.includes("\0")
  && value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git"), "input must be a relative workspace file");
export const WorkspaceInputSelectionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("write"), path, sha256: z.string().regex(/^[a-f0-9]{64}$/), executable: z.boolean() }).strict(),
  z.object({ action: z.literal("delete"), path }).strict(),
]);
export type WorkspaceInputSelection = z.infer<typeof WorkspaceInputSelectionSchema>;
