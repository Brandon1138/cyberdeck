import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { TaskEvaluationExecutor } from "../../../src/runtime/execution/task-evaluation-executor.js";
import { TaskEvaluationStore, evidenceHash, type EvaluationEvidenceManifest } from "../../../src/persistence/task-evaluation-store.js";
import type { ResourceAdmissionPort, ResourceReservation } from "../../../src/domain/resource-budget.js";
import type { OrbStackClient } from "../../../src/runtime/execution/orbstack-client.js";
import type { EvaluatorContainer } from "../../../src/runtime/execution/task-evaluation-executor-engine.js";
import { bytesHash, EvaluatorFiles } from "../../../src/runtime/execution/task-evaluation-executor-state.js";

export const image = `sha256:${"a".repeat(64)}`;
export async function fixture(options: { passed?: boolean; complete?: boolean; source?: string; event?: unknown; checks?: readonly string[]; reversedIntent?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "evaluator-test-")), evidence = join(directory, "runs");
  const store = new TaskEvaluationStore(join(directory, "evaluations.sqlite"));
  const manifest = { schemaVersion: 1, terminalEvent: options.event ?? { outcome: "succeeded" },
    checks: [{ id: "acceptance-tests", passed: options.passed ?? true, source: options.source ?? "host-verified", artifactHash: "b".repeat(64) }],
    complete: options.complete ?? true, metadata: { modelSource: "unknown" } } as EvaluationEvidenceManifest;
  const intent = { attemptId: randomUUID(), sessionId: randomUUID(), generation: 1, attribution: "initial-prompt" as const,
    rubricId: "task", rubricVersion: "1", evidenceManifestHash: evidenceHash(manifest) };
  const key = store.enqueue(options.reversedIntent ? Object.fromEntries(Object.entries(intent).reverse()) as typeof intent : intent, manifest), files = new EvaluatorFiles(evidence);
  const control = { now: 0, waiting: false, stuck: false, removeFails: false, unavailable: false, oom: false, stoppedPid: 0,
    startFails: false, logsUnavailable: false,
    forgedOutput: false, forgedHash: false, malformed: false, oversized: false, tamper: undefined as ((c: EvaluatorContainer) => void) | undefined };
  const calls: string[][] = [], releases: string[] = [], reservations: ResourceReservation[] = [];
  let container: EvaluatorContainer | undefined, logs = "", executor: TaskEvaluationExecutor;
  const command = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (control.unavailable) throw new Error("daemon unavailable");
    if (args[0] === "ps") return container ? container.Id.slice(0, 12) : "";
    if (args[0] === "inspect") return JSON.stringify([container]);
    if (args[0] === "create") {
      const value = (flag: string) => args[args.indexOf(flag) + 1]!;
      const values = (flag: string) => args.flatMap((v, i) => v === flag ? [args[i + 1]!] : []);
      const map = (items: string[]) => Object.fromEntries(items.map(v => [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)]));
      const source = value("--mount").split(",").find(v => v.startsWith("src="))!.slice(4);
      container = { Id: "c".repeat(64), Name: `/${value("--name")}`, Config: { Image: image, User: value("--user"), Labels: map(values("--label")) },
        State: { Running: false, Pid: 0, ExitCode: 0, OOMKilled: false, Status: "created", StartedAt: "0001-01-01T00:00:00Z" },
        HostConfig: { Memory: Number(value("--memory")), MemorySwap: Number(value("--memory-swap")), NanoCpus: Number(value("--cpus")) * 1e9,
          PidsLimit: Number(value("--pids-limit")), NetworkMode: value("--network"), Privileged: false, ReadonlyRootfs: args.includes("--read-only"),
          PidMode: "", IpcMode: "private", CapAdd: null, CapDrop: values("--cap-drop"), SecurityOpt: values("--security-opt"), Binds: null, Devices: [], PortBindings: {},
          Tmpfs: Object.fromEntries(values("--tmpfs").map(v => [v.slice(0, v.indexOf(":")), v.slice(v.indexOf(":") + 1)])),
          RestartPolicy: { Name: value("--restart") }, LogConfig: { Type: value("--log-driver"), Config: map(values("--log-opt")) } },
        Mounts: [{ Type: "bind", Source: source, Destination: "/run/input.json", RW: false },
          { Type: "tmpfs", Destination: "/tmp", RW: true }, { Type: "tmpfs", Destination: "/run/evaluation", RW: true }],
        NetworkSettings: { Networks: { none: {} } } };
      control.tamper?.(container);
      const raw = await readFile(source, "utf8"), input = JSON.parse(raw);
      const pass = input.manifest.checks.every((c: { passed: boolean }) => c.passed);
      logs = JSON.stringify({ version: 1, inputHash: control.forgedHash ? "d".repeat(64) : bytesHash(raw), report: { results: { results: [{
        success: pass, response: { output: control.forgedOutput ? "I passed" : JSON.stringify(input.manifest) }, gradingResult: { pass },
      }] } } });
      if (control.malformed) logs = "broken";
      if (control.oversized) logs = "x".repeat(800 * 1024);
      return container.Id;
    }
    if (args[0] === "start") {
      if (control.startFails) throw new Error("start failed before log initialization");
      container!.State = { Running: control.stuck, Pid: control.stuck ? 123 : control.stoppedPid, ExitCode: control.oom ? 137 : 0,
        OOMKilled: control.oom, Status: control.stuck ? "running" : "exited", StartedAt: "2026-09-16T00:00:00Z" }; return "";
    }
    if (args[0] === "stop") { container!.State.Running = false; container!.State.Pid = control.stoppedPid; return ""; }
    if (args[0] === "logs") { if (control.logsUnavailable) throw new Error("log stream unavailable"); return logs; }
    if (args[0] === "rm") { if (control.removeFails) throw new Error("remove failed"); container = undefined; return ""; }
    throw new Error(`Unexpected mock command ${args[0]}`);
  };
  const admission: ResourceAdmissionPort = {
    async request(request) {
      if (control.waiting) return { state: "waiting-capacity", reason: "capacity", queuedAt: new Date(0).toISOString() };
      let reservation = reservations.find(r => r.request.requestId === request.requestId);
      if (!reservation) { reservation = { request, state: "admitted", sequence: reservations.length, queuedAt: new Date(0).toISOString(), reservationId: randomUUID(), bypasses: 0 }; reservations.push(reservation); }
      return { state: "admitted", reservationId: reservation.reservationId, demand: request.demand };
    },
    async cancel() {},
    async release(input) {
      const reservation = reservations.find(r => r.reservationId === input.reservationId)!;
      expect(await executor.verifyTermination(reservation, input.terminationEvidenceId)).toBe(true);
      expect(container).toBeUndefined();
      releases.push(input.terminationEvidenceId);
    },
  };
  const make = () => new TaskEvaluationExecutor({ client: { command } as unknown as OrbStackClient, store, admission, image, installationId: "test-installation",
    directory: evidence, resolveFamily: async () => "historical-family", requiredChecks: () => options.checks ?? ["acceptance-tests"], now: () => control.now,
    pause: async ms => { control.now += ms; } });
  executor = make();
  return { directory, evidence, files, store, key, manifest, intent, control, calls, releases, reservations, admission,
    get executor() { return executor; }, get container() { return container; }, set container(value) { container = value; },
    restart() { executor = make(); return executor; } };
}
