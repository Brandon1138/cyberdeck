import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";

export type DesktopOpenResult = { status: "opened" } | { status: "unavailable"; reason: string };
export type DesktopCommand = (command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
  status: number | null;
  stdout?: string;
  error?: NodeJS.ErrnoException;
};
export interface DesktopOpenOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  release?: string;
  application?: string;
  run?: DesktopCommand;
}
export function openDesktop(target: { kind: "url" | "file"; value: string }, options?: DesktopOpenOptions): DesktopOpenResult;
