import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export interface ContainerCredentialInput {
  provider: "claude" | "codex";
  apiKey: string;
  reportingToken: string;
}
/** Explicit values only. No ambient provider config, Keychain, refresh writes or host home copying. */
export async function stageContainerCredentials(root: string, executionId: string, input: ContainerCredentialInput): Promise<string> {
  z.uuid().parse(executionId);
  if (!input.apiKey || !/^[a-f0-9]{64}$/.test(input.reportingToken)) throw new Error("CONTAINER_CREDENTIALS_UNAVAILABLE");
  const directory = join(root, executionId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  try {
    for (const [name, body] of Object.entries({
      "provider.json": JSON.stringify({ provider: input.provider, apiKey: input.apiKey }),
      "reporting-token": input.reportingToken,
    })) {
      const handle = await open(join(directory, name), "wx", 0o600);
      try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    }
    return directory;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
