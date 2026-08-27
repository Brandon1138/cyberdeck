import type { FleetRuntimeOptions } from "./runtime-options.js";

export type FleetRuntimeDeps = Pick<
  FleetRuntimeOptions,
  "permissionPreferences" | "runShellCommand"
>;
