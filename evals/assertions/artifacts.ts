import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ScenarioEvidenceSchema } from "./evidence.js";
export async function verifyEvidenceArtifacts(raw: unknown): Promise<string[]> {
  const parsed = ScenarioEvidenceSchema.safeParse(raw);
  if (!parsed.success) return ["evidence-schema-invalid"];
  const failures: string[] = [];
  for (const artifact of parsed.data.artifacts) {
    try {
      const file = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 64 * 1024 ** 2) { failures.push("artifact-file-invalid"); continue; }
        const actual = createHash("sha256").update(await file.readFile()).digest("hex");
        if (actual !== artifact.sha256) failures.push("artifact-hash-mismatch");
      } finally { await file.close(); }
    } catch { failures.push("artifact-unavailable"); }
  }
  return failures;
}
