import type { SessionRecord } from "../domain/session.js";

export interface ProviderLaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ProviderAdapter {
  readonly id: "codex" | "claude";
  buildLaunchSpec(session: SessionRecord): ProviderLaunchSpec;
}
