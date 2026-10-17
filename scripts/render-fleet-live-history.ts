/** Pure Fleet fixtures. No broker, provider, tmux, user config or network access. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionRecord } from "../src/domain/session.js";
import { isTerminalWorkerTruth, type WorkerTruthState } from "../src/domain/worker-truth.js";
import { createFleetState, renderFleet, transitionFleet, type FleetState, type FleetThread, type FleetSnapshot } from "../src/client/fleet.js";
import { normalizeState } from "../src/client/fleet/normalize.js";
import { printedWidth } from "../src/client/fleet/render-composer.js";
import type { PullRequestSummary } from "../src/client/pr-status.js";

const home = "/Users/brandon";
const now = Date.parse("2026-10-14T19:00:00.000Z");
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
function thread(id: string, name: string, state: WorkerTruthState, cwd: string, minutes = 2, kind: "worker" | "orchestrator" = "worker"): FleetThread {
  const terminal = ["stopped", "exited", "failed"].includes(state);
  return {
    record: { id, name, kind, provider: "codex", model: "gpt-6.1-sol", effort: "max", cwd,
      sandbox: "workspace-write", detached: true, attachmentState: "detached", createdAt: at(5000),
      updatedAt: at(minutes), meaningfulUpdatedAt: at(minutes), executionState: terminal ? state === "stopped" ? "cancelled" : state : "active",
      childIds: [], exitCode: terminal ? state === "failed" ? 1 : 0 : null, pid: terminal ? null : 1234,
      latestPreview: "I traced the issue and retained the existing input values.",
      latestPreviewKind: "assistant",
      observedModel: { model: "gpt-6.1-sol", effort: "max", source: "codex-rollout", observedAt: at(minutes) },
    } as SessionRecord,
    workerTruth: { state, terminal: isTerminalWorkerTruth(state), completedTurns: 2, canonicalTurns: 2, pendingInstructions: 0,
      modalOpen: state === "blocked-modal", composerOccupied: state === "blocked-composer", taskOutcome: "unknown",
      detail: state === "unknown" ? "Current provider screen is unrecognized; no idle or completion claim is available"
        : state === "blocked-modal" ? "Approve the provider's permission prompt to continue"
          : state === "provider-limit" ? "Session usage cap reached; inspect the provider's reset time" : `Observed ${state}` },
  };
}

export function representativeFleet(): { snapshot: FleetSnapshot; state: FleetState; pullRequests: Map<string, PullRequestSummary> } {
  const cyberdeck = `${home}/code/personal/cyberdeck`, parking = `${home}/code/work/start-parking`;
  const primary = thread("primary", "cd-orc / primary", "working", cyberdeck, 18, "orchestrator");
  primary.controllerId = "controller-primary"; primary.record.provider = "claude"; primary.record.model = "fable";
  primary.record.effort = "high"; primary.record.observedModel = { model: "fable", effort: "high", source: "claude-transcript", observedAt: at(18) } as never;
  primary.record.orchestratorScope = "fleet";
  const peer = thread("peer", "cd-orc / checkout review", "unknown", cyberdeck, 240, "orchestrator");
  peer.controllerId = "controller-peer"; peer.createdBy = { sessionId: "primary" };
  const canary = thread("canary", "Codex canary: verify all checkout transitions", "working", "/private/tmp/start-parking-canary-工程", 1);
  canary.record.workspace = { worktreePath: canary.record.cwd, repositoryPath: parking, branch: "cyberdeck/checkout-canary", baseRef: "HEAD", provisioning: "cyberdeck-provisioned", writableRoots: [] };
  const blocked = thread("blocked", "Preserve invalid booking fields and report every error", "blocked-modal", parking, 4);
  const failed = thread("failed", "Investigate provider startup failure", "failed", cyberdeck, 7);
  const unknown = thread("unknown", "Trace the native conversation binding after /clear", "unknown", cyberdeck, 3);
  delete unknown.record.observedModel;
  const limited = thread("limited", "Recover the provider session at its usage limit", "provider-limit", cyberdeck, 8);
  for (const entry of [canary, blocked, failed, unknown, limited]) entry.coordination = {
    sessionId: entry.record.id, subjectId: entry.record.id,
    origin: { creatorControllerId: "controller-primary", creatorSessionId: "primary", taskId: entry.record.id, threadId: entry.record.id, createdAt: entry.record.createdAt },
    currentController: { controllerId: entry === limited ? "controller-peer" : "controller-primary", familyId: "primary", scope: "fleet" },
    leaseHealth: entry === failed ? "contested" : "active", orphaned: false, adoptable: false,
  };
  const idle = thread("idle", "Reconcile gate corrections – awaiting next task", "idle", parking, 10); idle.record.pinned = true;
  const history = Array.from({ length: 8 }, (_, index) => thread(`history-${index}`, [
    "Repair exact activity navigation", "Check identity across broker recovery", "Retain checkout validation errors", "Review gate closure concurrency",
    "Render 日本語 and emoji 👩‍💻 paths", "Audit preference persistence", "Preserve explicit worker stop", "Verify provider-native model evidence",
  ][index]!, index % 2 === 0 ? "stopped" : "exited", index < 3 ? parking : cyberdeck, 30 + index * 120));
  const oldOrcs = Array.from({ length: 3 }, (_, index) => thread(`old-orc-${index}`, `cd-orc / earlier investigation ${index + 1}`, "stopped", cyberdeck, 500 + index, "orchestrator"));
  const stray = thread("stray", "Scratch investigation outside registered projects", "exited", "/private/tmp/notes-é/工程", 400);
  const snapshot: FleetSnapshot = { threads: [primary, peer, canary, blocked, failed, unknown, limited, idle, ...history, ...oldOrcs, stray],
    projects: [parking, cyberdeck, `${home}/code/personal/ammo`, `${home}/code/personal/mikoshi`] };
  let state = createFleetState(snapshot, cyberdeck);
  state = { ...state, selectedSessionId: canary.record.id, collapsedCwds: ["/@unregistered"],
    launchProfiles: { [canary.record.cwd]: { provider: "codex", model: "gpt-6.1-sol", effort: "max" } } };
  for (const entry of [canary, primary]) {
    entry.record.latestPreview = entry === canary ? "The three checkout probes passed; final browser review is pending." : "The worker is ready for independent review.";
    entry.record.meaningfulUpdatedAt = at(0);
    entry.workerTruth!.canonicalTurns = 3; entry.workerTruth!.completedTurns = 3;
  }
  state = normalizeState(state, snapshot, now);
  const pullRequests = new Map<string, PullRequestSummary>([
    ["canary", { state: "open", number: 151 }],
    ["failed", { state: "checks-failing", number: 150 }],
    ["history-0", { state: "merged", number: 149 }],
  ]);
  return { snapshot, state, pullRequests };
}

async function writeArtifacts(): Promise<void> {
  const destination = resolve(process.argv[2] ?? ".local/fleet-renderings");
  await mkdir(destination, { recursive: true });
  const { snapshot, state, pullRequests } = representativeFleet();
  const variants: Array<[string, FleetState]> = [
    ["live", state],
    ["history", transitionFleet({ ...state, draft: "/view history" }, snapshot, "enter", now).state],
    ["unread", transitionFleet({ ...state, draft: "/view unread" }, snapshot, "enter", now).state],
    ["expanded", { ...state, expandedHistoryCwds: ["/@orcs", `${home}/code/work/start-parking`, `${home}/code/personal/cyberdeck`], expandedCwds: [`${home}/code/personal/cyberdeck`] }],
    ["unknown", { ...state, selectedSessionId: "unknown" }],
    ["help", { ...state, helpOpen: true }],
    ["draft", { ...state, draft: "Retain every input value in 工程 and verify the invalid form.\n".repeat(15) }],
    ["confirmation", { ...state, notice: "Delete thread + 0 descendants? press ctrl+x again", noticeTone: "confirmation" }],
    ["model-picker", transitionFleet({ ...state, draft: "/model" }, snapshot, "enter", now).state],
  ];
  const measurements: unknown[] = [];
  for (const [width, height] of [[60, 50], [100, 45], [160, 55], [32, 18]] as const) {
    for (const [name, variant] of variants) {
      for (const color of [false, true]) {
        const text = renderFleet(snapshot, variant, { width, height, now, home, color, pullRequests });
        const rows = text.split("\n");
        const widths = rows.map(printedWidth);
        if (rows.length > height || widths.some((cells) => cells > width)) throw new Error(`${name} overran ${width}x${height}: ${rows.length} rows, max ${Math.max(...widths)} cells`);
        const file = `${width}x${height}-${name}.${color ? "ansi" : "txt"}`;
        await writeFile(join(destination, file), `${text}\n`, "utf8");
        measurements.push({ file, width, height, rows: rows.length, maximumDisplayWidth: Math.max(...widths), rowDisplayWidths: widths });
      }
    }
  }
  await writeFile(join(destination, "widths.json"), `${JSON.stringify(measurements, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote ${measurements.length} actual renderer artifacts to ${destination}; every row and frame is bounded.\n`);
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await writeArtifacts();
