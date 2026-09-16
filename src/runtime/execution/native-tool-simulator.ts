import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NativeCommand, NativeCommandResult, NativeProcessSupervisor, NativeToolRecipe } from "./native-tool-types.js";
import { writeNativeRecord } from "./native-tool-workspace.js";

/** Scoped simulator lifecycle. Every helper is itself executed under the existing reservation.
 * simctl shutdown/delete only receive the UUID returned by this run's create command. */
export class NativeToolSimulator {
  private uuid: string | undefined;
  constructor(private readonly supervisor: NativeProcessSupervisor,
    private readonly base: NativeCommand,
    private readonly context: Parameters<NativeProcessSupervisor["run"]>[1]) {}
  async create(recipe: NativeToolRecipe, requestId: string): Promise<string> {
    const result = await this.command("create", [`cyberdeck-${requestId}`, recipe.simulatorDeviceType, recipe.simulatorRuntime]);
    if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.reason) throw new Error("native-simulator-create-failed");
    const text = await readFile(join(this.base.artifactsDirectory, "simulator-create.log"), "utf8");
    const ids = text.match(/^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/gm);
    if (ids?.length !== 1) throw new Error("native-simulator-create-identity-unavailable");
    this.uuid = ids[0]!;
    await writeNativeRecord(join(this.base.artifactsDirectory, "simulator.json"), { uuid: this.uuid, requestId });
    return this.uuid;
  }
  async cleanup(): Promise<NativeCommandResult[]> {
    if (!this.uuid) return [];
    const results: NativeCommandResult[] = [];
    // Cleanup ignores the request's cancellation, but each helper retains a bounded timeout.
    const shutdown = await this.command("shutdown", [this.uuid], false);
    results.push(shutdown);
    // Shutdown of an already stopped device can return nonzero; deletion is exact-UUID scoped.
    results.push(await this.command("delete", [this.uuid], false));
    return results;
  }
  private command(action: string, args: string[], cancellable = true): Promise<NativeCommandResult> {
    const { signal, ...context } = this.context;
    return this.supervisor.run({ ...this.base, executable: "/usr/bin/xcrun", args: ["simctl", action, ...args],
      timeoutMs: Math.min(this.base.timeoutMs, 60000),
      logPath: join(this.base.artifactsDirectory, `simulator-${action}.log`) },
    { ...context, ...(cancellable && signal ? { signal } : {}) });
  }
}
