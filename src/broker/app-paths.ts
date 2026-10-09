import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

interface AppPathOptions {
  platform: NodeJS.Platform;
  homeDirectory: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  uid?: number;
}

interface AppPaths {
  brokerSocketPath: string;
  appStateDirectory: string;
  brokerConfigPath: string;
}

/** Resolve paths without touching state; relative XDG values are invalid per the XDG spec. */
export function resolveAppPaths(options: AppPathOptions): AppPaths {
  const xdgStateHome = options.environment.XDG_STATE_HOME;
  const stateHome = xdgStateHome && isAbsolute(xdgStateHome)
    ? xdgStateHome
    : join(options.homeDirectory, ".local", "state");
  const appStateDirectory = options.platform === "linux"
    ? join(stateHome, "cyberdeck")
    : join(options.homeDirectory, "Library", "Application Support", "Cyberdeck");

  return {
    // Keep the short, per-user socket address independent of durable state and desktop sessions.
    brokerSocketPath: `/tmp/cyberdeck-${options.uid ?? "user"}.sock`,
    appStateDirectory,
    brokerConfigPath: join(appStateDirectory, "config.json"),
  };
}

const paths = resolveAppPaths({
  platform: process.platform,
  homeDirectory: homedir(),
  environment: process.env,
  ...(process.getuid === undefined ? {} : { uid: process.getuid() }),
});

export const brokerSocketPath = paths.brokerSocketPath;
export const appStateDirectory = paths.appStateDirectory;
export const brokerConfigPath = paths.brokerConfigPath;
