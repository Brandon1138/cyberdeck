import { request } from "node:http";
import { z } from "zod";

const count = z.number().int().nonnegative();
const id = z.string().regex(/^[a-f0-9]{64}$/);
const StatsSchema = z.object({ id, read: z.iso.datetime({ offset: true }),
  memory_stats: z.object({ usage: count, limit: count }),
  cpu_stats: z.object({ cpu_usage: z.object({ total_usage: count }) }), pids_stats: z.object({ current: count }) });
const Inventory = z.array(z.object({ Id: id, Labels: z.record(z.string(), z.string()), State: z.string() })).max(128);
/** Host-only read-only Engine API; no engine capability is exposed to workers. */
async function read(socketPath: string, path: string): Promise<unknown> {
  if (!socketPath.startsWith("/")) throw new Error("RESOURCE_ENGINE_ID_INVALID");
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method: "GET", path }, res => {
      let size = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) req.destroy(new Error("RESOURCE_ENGINE_OUTPUT_LIMIT")); else chunks.push(chunk);
      });
      res.on("error", () => reject(new Error("RESOURCE_ENGINE_UNAVAILABLE")));
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) throw new Error("status");
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch { reject(new Error("RESOURCE_ENGINE_METRICS_INVALID")); }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error("RESOURCE_ENGINE_TIMEOUT")), 3000).unref();
    req.on("close", () => clearTimeout(deadline));
    req.on("error", () => reject(new Error("RESOURCE_ENGINE_UNAVAILABLE"))); req.end();
  });
}
export async function readDockerStats(socketPath: string, containerId: string) {
  id.parse(containerId);
  const value = StatsSchema.parse(await read(socketPath, `/containers/${containerId}/stats?stream=false&one-shot=true`));
  if (value.id !== containerId) throw new Error("RESOURCE_ENGINE_METRICS_INVALID");
  return { containerId, observedAt: value.read, memoryBytes: value.memory_stats.usage,
    memoryLimitBytes: value.memory_stats.limit, cpuNanos: value.cpu_stats.cpu_usage.total_usage, pids: value.pids_stats.current };
}
export async function readDockerInventory(socketPath: string) {
  const rows = Inventory.parse(await read(socketPath, "/containers/json?all=1"));
  if (new Set(rows.map(row => row.Id)).size !== rows.length) throw new Error("RESOURCE_CONTAINER_INVENTORY_INVALID");
  return rows.map(row => ({ id: row.Id, labels: row.Labels, running: ["running", "paused", "restarting"].includes(row.State) }));
}
