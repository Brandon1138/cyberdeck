import { parseArgs } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { appStateDirectory, brokerSocketPath } from "../src/broker/app-paths.js";
import { StrigoiSelectionSchema, type StrigoiSelection } from "../src/domain/strigoi.js";
export interface StrigoiGateOptions { mode: "lifecycle" | "crash" | "semantic"; stateDirectory: string; selection: StrigoiSelection; allowInference: boolean; validateOnly: boolean; caseId?: string }
export function parseStrigoiGate(args: string[]): StrigoiGateOptions {
  const { values: v } = parseArgs({ args, strict: true, options: { mode: { type: "string" }, "state-directory": { type: "string" },
    cwd: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, case: { type: "string" }, "allow-inference": { type: "boolean" }, "validate-only": { type: "boolean" } } });
  if (!["lifecycle", "crash", "semantic"].includes(v.mode ?? "") || !v["state-directory"] || !v.cwd || !v.model) throw new Error("Required: --mode lifecycle|crash|semantic --state-directory ABSOLUTE --cwd ABSOLUTE --model MODEL [--effort EFFORT] --allow-inference (or --validate-only)");
  if (v.mode !== "lifecycle" && !v.case) throw new Error("Required: --case for crash or semantic mode");
  if (v.mode === "lifecycle" && v.case) throw new Error("--case requires crash or semantic mode");
  if (v.mode === "crash" && !["passive", "reserved-launch"].includes(v.case!)) throw new Error("Unknown crash case");
  if (!isAbsolute(v["state-directory"]) || !isAbsolute(v.cwd)) throw new Error("State directory and cwd must be explicit absolute paths");
  if (!v["allow-inference"] && !v["validate-only"]) throw new Error("Live inference requires explicit --allow-inference");
  return { mode: v.mode as StrigoiGateOptions["mode"], ...(v.case ? { caseId: v.case } : {}), stateDirectory: resolve(v["state-directory"]), selection: StrigoiSelectionSchema.parse({ provider: "codex", model: v.model, cwd: v.cwd, effort: v.effort }),
    allowInference: v["allow-inference"] === true, validateOnly: v["validate-only"] === true };
}
const exists = async (path: string) => lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
const inside = (parent: string, child: string) => { const r = relative(parent, child); return r === "" || !r.startsWith("..") && !isAbsolute(r); };
export async function validateStrigoiGate(o: StrigoiGateOptions, protectedPaths = { state: appStateDirectory, socket: brokerSocketPath }): Promise<void> {
  const state = await exists(o.stateDirectory);
  if (state?.isSymbolicLink()) throw new Error("State directory must not be a symlink");
  const canonical = state ? await realpath(o.stateDirectory) : join(await realpath(dirname(o.stateDirectory)), o.stateDirectory.split("/").at(-1)!);
  const active = await realpath(protectedPaths.state).catch(() => resolve(protectedPaths.state));
  if (inside(active, canonical) || inside(canonical, active)) throw new Error("Refusing active broker state or an overlapping state directory");
  // The primary socket may exist. It is neither opened nor removed. Native sockets
  // belong exclusively to the fresh private CODEX_HOME under canonical.
  if (inside(canonical, resolve(protectedPaths.socket))) throw new Error("Isolated state overlaps the protected socket");
  if (state) throw new Error("Use a new absent isolated state directory; existing evidence is preserved");
  if (!(await lstat(await realpath(o.selection.cwd))).isDirectory()) throw new Error("cwd must be a directory");
  // Native RC adds its own Unix control socket suffix. Fail before launching an unusable home.
  if (Buffer.byteLength(join(canonical, "native", "cyberdeck-orchestrator")) > 65) throw new Error("Use a shorter isolated state path for the native Unix socket (for example a new directory under /tmp)");
}

