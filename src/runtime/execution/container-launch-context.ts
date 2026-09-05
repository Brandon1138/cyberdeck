import { isAbsolute } from "node:path";
import type { IsolatedWorkspace } from "../../orchestration/isolated-workspace-provisioner.js";

export interface ContainerLaunchContext {
  workspace: IsolatedWorkspace;
  hostState: string;
  hostCredentials: string;
  guest: { workspace: "/workspace"; home: "/home/worker"; credentials: "/run/credentials"; reportClient: "/opt/cyberdeck/report.mjs" };
  reportingUrl: string;
}
export function containerLaunchContext(input: Omit<ContainerLaunchContext, "guest">): ContainerLaunchContext {
  if (![input.workspace.hostPath, input.hostState, input.hostCredentials].every(isAbsolute)
    || new Set([input.workspace.hostPath, input.hostState, input.hostCredentials]).size !== 3) throw new Error("CONTAINER_PATH_MAP_INVALID");
  const url = new URL(input.reportingUrl);
  if (url.protocol !== "http:" || url.hostname !== "host.docker.internal" || !url.port || url.username || url.password || url.pathname !== "/v1/report") throw new Error("CONTAINER_GATEWAY_INVALID");
  return { ...input, guest: { workspace: "/workspace", home: "/home/worker", credentials: "/run/credentials", reportClient: "/opt/cyberdeck/report.mjs" } };
}
