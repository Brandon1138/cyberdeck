import type { SessionRecord } from "../domain/session.js";
import type { ProviderAdapter, ProviderLaunchSpec } from "./provider.js";

const permissionModes = {
  "read-only": "plan",
  "workspace-write": "manual",
} as const;

export class ClaudeProviderAdapter implements ProviderAdapter {
  readonly id = "claude" as const;

  buildLaunchSpec(session: SessionRecord): ProviderLaunchSpec {
    const args = [
      "--session-id",
      session.id,
      "--name",
      session.name ?? session.id,
      "--permission-mode",
      permissionModes[session.sandbox],
    ];
    if (session.model !== undefined) {
      args.push("--model", session.model);
    }

    return {
      executable: "claude",
      args,
      cwd: session.cwd,
      env: { ...process.env, DISABLE_UPDATES: "1" },
    };
  }
}
