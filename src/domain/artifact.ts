import { isAbsolute } from "node:path";
import { z } from "zod";
import { ArtifactIdSchema, JobIdSchema, TimestampSchema, schemaVersionField } from "./control-plane.js";

/**
 * A reference to where artifact content lives. A1 defines the descriptor and reference shapes only;
 * no storage is implemented. `inline` carries small content directly, `file` points at an absolute
 * local path, and `external` names an out-of-process URI.
 */
export const ContentReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline"), mediaType: z.string().min(1), text: z.string() }),
  z.object({
    kind: z.literal("file"),
    path: z.string().refine(isAbsolute, "path must be an absolute path"),
    mediaType: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("external"),
    uri: z.string().min(1),
    mediaType: z.string().min(1).optional(),
  }),
]);
export type ContentReference = z.infer<typeof ContentReferenceSchema>;

export const ArtifactDescriptorSchema = z.object({
  schemaVersion: schemaVersionField,
  id: ArtifactIdSchema,
  name: z.string().min(1),
  mediaType: z.string().min(1),
  byteLength: z.number().int().nonnegative().optional(),
  digest: z.string().optional(),
  content: ContentReferenceSchema,
  producedByJobId: JobIdSchema.optional(),
  createdAt: TimestampSchema,
});
export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptorSchema>;
