import type { ProviderAdapter, ProviderLaunchSpec } from "./provider.js";
import type { SessionRecord } from "../domain/session.js";

export class CodexProviderAdapter implements ProviderAdapter {
  readonly id = "codex" as const;

  buildLaunchSpec(session: SessionRecord): ProviderLaunchSpec {
    const args = [
      "--no-alt-screen",
      "-C",
      session.cwd,
      "-s",
      session.sandbox,
      "-a",
      "on-request",
    ];
    if (session.model !== undefined) {
      args.push("-m", session.model);
    }

    return {
      executable: "codex",
      args,
      cwd: session.cwd,
      env: { ...process.env },
    };
  }
}
