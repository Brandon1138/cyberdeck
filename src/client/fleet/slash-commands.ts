import { homedir } from "node:os";
import { imageInputRefusal, providerAcceptsImages, providerAttachesImagesAtLaunch } from "../../domain/image-input.js";
import type { CavemanWorkersResult, OrchestratorGrantToggleResult } from "../../domain/orchestrator.js";
import type { SessionRecord } from "../../domain/session.js";
import { composerImageAttachments } from "../clipboard-image.js";
import { resolveProviderPermission } from "../permission-policy.js";
import { ANSI } from "./constants.js";
import { composerCwd, composerWorkspace, taskName } from "./model-labels.js";
import { openWorkerPickerForCwd } from "./picker-worker.js";
import { fit } from "./render-composer.js";
import { FleetNoticeTone, FleetSnapshot, FleetState, FleetTransition, LaunchProfile, WorkerIsolation } from "./state.js";

export function startTransition(
  state: FleetState,
  selected: SessionRecord | undefined,
  draft: string,
): FleetTransition {
  if (draft.startsWith("/")) {
    return { state: { ...state, notice: "Use /model to configure a new worker", noticeTone: "error" } };
  }
  const cwd = state.workingDirectory ?? selected?.cwd ?? state.fallbackCwd;
  const profile = state.launchProfiles[cwd];
  if (profile === undefined) {
    return openWorkerPickerForCwd(state, cwd, draft);
  }
  const initialPrompt = draft;
  // Read off the draft rather than out of a list held beside it, so what the operator can see is
  // what launches. This is also the only gate a *typed* or dropped path passes through — a
  // terminal drop types the path in and never touches ctrl+v — so the refusal lives here as well
  // as on the chord, and neither surface can let an image through in silence.
  const images = composerImageAttachments(initialPrompt);
  if (images.length > 0 && !providerAcceptsImages(profile.provider)) {
    return {
      state: {
        ...state,
        notice: `${imageInputRefusal(profile.provider, images.length)} — remove the path or /model to a provider that can`,
        noticeTone: "error",
      },
    };
  }
  const sandbox = selected?.sandbox ?? "read-only";
  const policy = state.permissionPolicies[profile.provider] ?? "permissioned";
  const permission = resolveProviderPermission(profile.provider, policy, sandbox);
  if (!permission.ok) {
    return {
      state: {
        ...state,
        notice: permission.message,
        noticeTone: "error",
      },
    };
  }
  const approvalMode = permission.value.application.kind === "approval-mode"
    && permission.value.application.value === "auto"
    ? { approvalMode: permission.value.application.value }
    : {};
  return {
    state: { ...state, draft: "", deleteConfirmation: undefined, notice: undefined },
    action: {
      type: "start",
      request: {
        provider: profile.provider,
        model: profile.model,
        ...(profile.effort === undefined ? {} : { effort: profile.effort }),
        cwd,
        sandbox,
        ...approvalMode,
        detached: true,
        name: taskName(initialPrompt),
        initialPrompt,
        // Sent only to a provider whose CLI has a flag to carry them. The paths stay in the prompt
        // regardless, so a provider that reads its images from the text is served by the text and
        // is handed no list the launch would drop.
        ...(images.length > 0 && providerAttachesImagesAtLaunch(profile.provider)
          ? { imageAttachments: images }
          : {}),
        ...(profile.isolation === "worktree" ? { workspace: composerWorkspace(initialPrompt) } : {}),
      },
      ...(permission.value.application.kind === "post-launch-command"
        ? { permissionLaunch: permission.value }
        : {}),
    },
  };
}

/**
 * One `/<grant>-workers status|on|off` command against the bound orchestrator of the current scope.
 * Every delegation grant the operator can toggle from Fleet routes through here, so they cannot
 * drift apart in which binding they address or how a missing binding is reported.
 */
export function grantToggleTransition(
  state: FleetState,
  snapshot: FleetSnapshot,
  command: string,
  grant: { name: "/fable-workers"; action: "fable-workers"; },
): FleetTransition | undefined {
  if (!command.startsWith(grant.name)) return undefined;
  const match = new RegExp(`^${grant.name}(?:\\s+(status|on|off))?$`, "u").exec(command);
  if (match === null) {
    return {
      state: {
        ...state,
        draft: "",
        notice: `Usage: ${grant.name} status|on|off`,
        noticeTone: "error",
      },
    };
  }
  const orchestrator = policyOrchestrator(snapshot, state);
  if (orchestrator === undefined) {
    return {
      state: {
        ...state,
        draft: "",
        notice: "No orchestrator is bound; press ctrl+o to choose one",
        noticeTone: "error",
      },
    };
  }
  const mode = match[1] ?? "status";
  return {
    state: { ...state, draft: "", notice: undefined },
    action: {
      type: grant.action,
      request: {
        cwd: orchestrator.cwd,
        scope: orchestrator.orchestratorScope ?? "workspace",
        ...(mode === "status" ? {} : { enabled: mode === "on" }),
      },
    },
  };
}

export function cavemanWorkersTransition(
  state: FleetState,
  _snapshot: FleetSnapshot,
  command: string,
): FleetTransition | undefined {
  if (!command.startsWith("/caveman-workers")) return undefined;
  const match = /^\/caveman-workers(?:\s+(status|on|off))?$/u.exec(command);
  if (match === null) {
    return {
      state: {
        ...state,
        draft: "",
        notice: "Usage: /caveman-workers status|on|off",
        noticeTone: "error",
      },
    };
  }
  const mode = match[1] ?? "status";
  return {
    state: { ...state, draft: "", notice: undefined },
    action: {
      type: "caveman-workers",
      request: {
        ...(mode === "status" ? {} : { enabled: mode === "on" }),
      },
    },
  };
}

export function nvimLayoutTransition(
  state: FleetState,
  command: string,
): FleetTransition | undefined {
  if (!command.startsWith("/nvim-settings")) return undefined;
  const match = /^\/nvim-settings(?:\s+(status|on|off))?$/u.exec(command);
  if (match === null) {
    return {
      state: {
        ...state,
        draft: "",
        notice: "Usage: /nvim-settings status|on|off",
        noticeTone: "error",
      },
    };
  }
  const mode = match[1] ?? "status";
  if (mode === "status") {
    return {
      state: {
        ...state,
        draft: "",
        notice: `Automatic nvim layout: ${state.nvimLayoutEnabled ? "ON" : "OFF"}`,
        noticeTone: "neutral",
      },
    };
  }
  return {
    state: { ...state, draft: "", notice: undefined },
    action: { type: "nvim-layout", enabled: mode === "on" },
  };
}

/**
 * `/worktree status|on|off` for the folder the composer is pointed at.
 *
 * Isolation is a per-folder decision rather than a per-worker one because the operator makes it
 * once, about a repository, and then stops thinking about it: either work in this project belongs
 * in its own worktree or it does not. It rides on the launch profile for the same reason the
 * provider and model do — it is what "start a worker here" means in this folder.
 */
export function worktreeModeTransition(
  state: FleetState,
  snapshot: FleetSnapshot,
  command: string,
): FleetTransition | undefined {
  if (!command.startsWith("/worktree")) return undefined;
  const match = /^\/worktree(?:\s+(status|on|off))?$/u.exec(command);
  if (match === null) {
    return {
      state: {
        ...state,
        draft: "",
        notice: "Usage: /worktree status|on|off",
        noticeTone: "error",
      },
    };
  }
  const cwd = composerCwd(state, snapshot);
  const profile = state.launchProfiles[cwd];
  const mode = match[1] ?? "status";
  if (mode === "status") {
    return {
      state: {
        ...state,
        draft: "",
        notice: profile === undefined
          ? `${shortPath(cwd, homedir())} has no worker profile yet — /model first`
          : `Own worktree per worker in ${shortPath(cwd, homedir())}: ${profile.isolation === "worktree" ? "ON" : "OFF"
          }`,
        noticeTone: "neutral",
      },
    };
  }
  if (profile === undefined) {
    return {
      state: {
        ...state,
        draft: "",
        notice: "Choose a worker with /model before setting how it is isolated",
        noticeTone: "error",
      },
    };
  }
  const isolation: WorkerIsolation = mode === "on" ? "worktree" : "shared";
  const updated: LaunchProfile = { ...profile, isolation };
  return {
    state: {
      ...state,
      draft: "",
      launchProfiles: { ...state.launchProfiles, [cwd]: updated },
      notice: isolation === "worktree"
        ? "Workers started here get their own worktree, cut by Cyberdeck"
        : "Workers started here run in this folder",
      noticeTone: "neutral",
    },
    action: { type: "profile", cwd, profile: updated },
  };
}

export function workerPolicyTransition(
  state: FleetState,
  snapshot: FleetSnapshot,
  command: string,
): FleetTransition | undefined {
  return grantToggleTransition(state, snapshot, command, {
    name: "/fable-workers",
    action: "fable-workers",
  })
    ?? cavemanWorkersTransition(state, snapshot, command)
    ?? nvimLayoutTransition(state, command)
    ?? worktreeModeTransition(state, snapshot, command);
}

export function policyOrchestrator(snapshot: FleetSnapshot, state: FleetState): SessionRecord | undefined {
  const selected = snapshot.threads.find(({ record }) => record.id === state.selectedSessionId)?.record;
  if (selected?.kind === "orchestrator") return selected;
  return snapshot.threads.find(({ record }) =>
    record.kind === "orchestrator" && record.orchestratorScope === "fleet")?.record
    ?? snapshot.threads.find(({ record }) =>
      record.kind === "orchestrator" && record.cwd === state.fallbackCwd)?.record
    ?? snapshot.threads.find(({ record }) => record.kind === "orchestrator")?.record;
}

export function grantToggleNotice(
  label: string,
  result: OrchestratorGrantToggleResult,
): string {
  if (!result.configured) return `${label}: OFF · no orchestrator bound for ${result.key}`;
  return `${label}: ${result.enabled ? "ON" : "OFF"} · ${result.key} · ${result.sessionId}`;
}

export function cavemanWorkersNotice(result: CavemanWorkersResult): string {
  return `Caveman workers: ${result.enabled ? "ON" : "OFF"} · box default · orchestrator-spawned workers`;
}

export function shortPath(path: string, home: string): string {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function relativeTime(timestamp: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(timestamp));
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function statusText(status: string, pendingDelete: boolean, color: boolean): string {
  const label = status.trim();
  if (pendingDelete || label === "Failed") return paint(status, "alert", color);
  // Four states carry a hue: finished, blocked, failing, and the one live thread.
  // Stopping, Stopped and Interrupted are inert, not a request, and stay greyscale.
  if (label === "Done") return paint(status, "done", color);
  if (label === "Needs input") return paint(status, "attention", color);
  if (label === "Working") return paint(status, "working", color);
  return paint(status, "muted", color);
}

export function paint(value: string, tone: keyof typeof ANSI, enabled: boolean): string {
  return enabled ? `${ANSI[tone]}${value}${ANSI.reset}` : value;
}

export function renderNotice(
  notice: string,
  tone: FleetNoticeTone | undefined,
  width: number,
  color: boolean,
): string {
  const value = fit(notice, width);
  if (tone === "warning") return paint(value, "attention", color);
  if (tone === "error" || tone === "confirmation") return paint(value, "alert", color);
  return value;
}

/**
 * What the composer row is collecting: a task to dispatch, a new thread name, a project path, or a
 * shell line.
 */
