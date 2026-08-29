import { basename } from "node:path";
import type { FleetProjectAddResult, FleetProjectRemoveResult, } from "../../broker/fleet-project-service.js";
import { imageInputRefusal, providerAcceptsImages, providerImageMechanism } from "../../domain/image-input.js";
import type { CavemanWorkersResult, FableWorkersResult } from "../../domain/orchestrator.js";
import type { SessionRecord } from "../../domain/session.js";
import type { WorkerHandoffResult } from "../../orchestration/worker-handoff-service.js";
import { draftWithImageReference } from "../clipboard-image.js";
import { completeDirectoryPath } from "../path-completion.js";
import { RpcError } from "../rpc-client.js";
import { orderedThreads } from "./list-rows.js";
import { composerCwd } from "./model-labels.js";
import { handoffNotice } from "./picker-handoff.js";
import { existingOrchestrators, orchestratorFocusAt } from "./picker-orchestrator.js";
import { adoptWorkerModels, appendShellOutput } from "./picker-worker.js";
import { layoutOrchestratorSessionIds } from "./render-rows.js";
import { FleetRuntimeOptions, OrchestratorCockpitTarget, ResolvedFleetRenderOptions } from "./runtime-options.js";
import { cavemanWorkersNotice, grantToggleNotice, shortPath } from "./slash-commands.js";
import { FleetSnapshot, FleetState, InteractiveFleetTransport } from "./state.js";
import { collectFleetSnapshot, startFleetSession } from "./transport.js";

import { readWorkerModels } from "./runtime-frame.js";

import type { FleetAction } from "./state.js";

export interface FleetActionExecution {
  state: FleetState;
  snapshot: FleetSnapshot;
  nvimLayoutHookInstalled: boolean;
}

export interface ExecuteFleetActionContext {
  client: InteractiveFleetTransport;
  runtime: FleetRuntimeOptions;
  permissionPreferences: FleetRuntimeOptions["permissionPreferences"];
  pasteboardImage: NonNullable<FleetRuntimeOptions["pasteboardImage"]>;
  renderOptions: ResolvedFleetRenderOptions;
  state: FleetState;
  snapshot: FleetSnapshot;
  action: FleetAction | undefined;
  nvimLayoutHookInstalled: boolean;
  openNativeThread(
    sessionId: string,
    state: FleetState,
  ): Promise<{ state: FleetState; snapshot: FleetSnapshot; }>;
  openOrchestrator(
    target: OrchestratorCockpitTarget,
    state: FleetState,
    snapshot: FleetSnapshot,
    nvimLayoutHookInstalled: boolean,
  ): Promise<FleetActionExecution>;
  setShellInterrupt(interrupt: AbortController | undefined): void;
  updateState(state: FleetState): void;
  notify(): void;
}

export async function executeFleetAction(
  context: ExecuteFleetActionContext,
): Promise<FleetActionExecution> {
  const {
    client,
    runtime,
    permissionPreferences,
    pasteboardImage,
    renderOptions,
    action,
  } = context;
  let { state, snapshot, nvimLayoutHookInstalled } = context;
  try {
    if (action?.type === "stop") {
      await client.request("session.stopOne", { sessionId: action.sessionId });
      state = {
        ...state,
        notice: "Stopping thread",
        noticeTone: "warning",
      };
    } else if (action?.type === "delete") {
      const selectedIndex = Math.max(
        0,
        orderedThreads(snapshot).findIndex(({ record }) => record.id === action.sessionId),
      );
      // Deleting the focused row is the one moment the picker's focus cannot survive as an id.
      // Its position in the pre-delete list is read here so focus can land on the neighbour the
      // row leaves behind, and is turned straight back into an id below.
      const picker = state.orchestratorPicker;
      const pickerIndex = picker?.step === "target"
        && picker.focus.kind === "existing"
        && picker.focus.sessionId === action.sessionId
        ? existingOrchestrators(snapshot).findIndex((record) => record.id === action.sessionId)
        : -1;
      await client.request("session.delete", { sessionId: action.sessionId });
      snapshot = await collectFleetSnapshot(client);
      const remaining = orderedThreads(snapshot);
      const remainingExisting = existingOrchestrators(snapshot);
      state = {
        ...state,
        selectedSessionId: remaining[selectedIndex]?.record.id ?? remaining[selectedIndex - 1]?.record.id,
        notice: "Deleted thread",
        noticeTone: "neutral",
        ...(picker?.step === "target" && pickerIndex >= 0
          ? {
            orchestratorPicker: {
              ...picker,
              focus: orchestratorFocusAt(
                remainingExisting[pickerIndex] !== undefined
                  ? pickerIndex
                  : Math.max(0, pickerIndex - 1),
                remainingExisting,
              ),
              stopAcknowledgement: undefined,
              deleteConfirmation: undefined,
            },
          }
          : {}),
      };
    } else if (action?.type === "attach") {
      ({ state, snapshot } = await context.openNativeThread(action.sessionId, state));
    } else if (action?.type === "resume") {
      await client.request<SessionRecord>("session.resume", { sessionId: action.sessionId });
      snapshot = await collectFleetSnapshot(client);
      ({ state, snapshot } = await context.openNativeThread(action.sessionId, state));
    } else if (action?.type === "start") {
      const record = await startFleetSession(client, action);
      state = { ...state, selectedSessionId: record.id };
      snapshot = await collectFleetSnapshot(client);
      ({ state, snapshot } = await context.openNativeThread(record.id, state));
    } else if (action?.type === "open-orchestrator") {
      const session = snapshot.threads.find(({ record }) => record.id === action.sessionId)?.record;
      if (session === undefined) throw new Error("Selected orchestrator is no longer available");
      ({ state, snapshot, nvimLayoutHookInstalled } = await context.openOrchestrator({
        type: "existing",
        session,
        cockpitCwd: action.cockpitCwd,
        requiresResume: action.requiresResume,
      }, state, snapshot, nvimLayoutHookInstalled));
    } else if (action?.type === "create-orchestrator") {
      ({ state, snapshot, nvimLayoutHookInstalled } = await context.openOrchestrator({
        type: "create",
        request: action.request,
        cockpitCwd: action.cockpitCwd,
      }, state, snapshot, nvimLayoutHookInstalled));
    } else if (action?.type === "fable-workers") {
      const result = await client.request<FableWorkersResult>(
        "orchestrator.fableWorkers",
        action.request,
      );
      state = {
        ...state,
        notice: grantToggleNotice("Fable workers", result),
        noticeTone: "neutral",
      };
    } else if (action?.type === "caveman-workers") {
      const result = await client.request<CavemanWorkersResult>(
        "orchestrator.cavemanWorkers",
        action.request,
      );
      state = { ...state, notice: cavemanWorkersNotice(result), noticeTone: "neutral" };
    } else if (action?.type === "nvim-layout") {
      if (runtime.nvimLayoutHooks === undefined) {
        throw new Error("Automatic nvim layout is unavailable in this Fleet client");
      }
      const orchestratorSessionIds = layoutOrchestratorSessionIds(snapshot);
      if (action.enabled) {
        await runtime.nvimLayoutHooks.install(orchestratorSessionIds);
        nvimLayoutHookInstalled = true;
        try {
          await client.request("fleet.nvimLayout.set", { enabled: true });
        } catch (error) {
          await runtime.nvimLayoutHooks.remove();
          nvimLayoutHookInstalled = false;
          throw error;
        }
      } else {
        await runtime.nvimLayoutHooks.remove();
        nvimLayoutHookInstalled = false;
        try {
          await client.request("fleet.nvimLayout.set", { enabled: false });
        } catch (error) {
          await runtime.nvimLayoutHooks.install(orchestratorSessionIds);
          nvimLayoutHookInstalled = true;
          throw error;
        }
      }
      state = {
        ...state,
        nvimLayoutEnabled: action.enabled,
        notice: `Automatic nvim layout: ${action.enabled ? "ON" : "OFF"}`,
        noticeTone: "neutral",
      };
    } else if (action?.type === "rename") {
      await client.request("session.rename", { sessionId: action.sessionId, name: action.name });
    } else if (action?.type === "pin") {
      await client.request("session.togglePin", { sessionId: action.sessionId });
    } else if (action?.type === "reorder") {
      await client.request("session.reorder", {
        sessionId: action.sessionId,
        direction: action.direction,
      });
    } else if (action?.type === "profile") {
      await client.request("fleet.preference.set", { cwd: action.cwd, profile: action.profile });
    } else if (action?.type === "handoff") {
      const result = await client.request<WorkerHandoffResult>("fleet.workerHandoff", {
        recipientSessionId: action.recipientSessionId,
        workerIds: action.workerIds,
        directive: action.directive,
        mutationId: action.mutationId,
      });
      state = {
        ...state,
        // Marks are cleared only by a transfer that actually happened. A refused batch leaves the
        // operator holding exactly what they marked, to fix and retry or to unmark.
        ...(result.committed ? { handoffMarks: [] } : {}),
        notice: handoffNotice(result),
        noticeTone: result.committed
          ? result.delivery === "delivered" || result.delivery === "pending" ? "neutral" : "warning"
          : "error",
      };
    } else if (action?.type === "worker-capabilities") {
      state = adoptWorkerModels(state, await readWorkerModels(client));
    } else if (action?.type === "folder-disposition") {
      await client.request("fleet.folderDisposition.set", {
        key: action.cwd,
        disposition: action.disposition,
      });
    } else if (action?.type === "permission-policy") {
      if (permissionPreferences === undefined) {
        throw new Error("Permission preferences are unavailable in this Fleet client");
      }
      await permissionPreferences.set(action.provider, action.policy);
    } else if (action?.type === "open-worktree") {
      if (runtime.openWorktree === undefined) {
        throw new Error("nvim worktree navigation is unavailable in this client");
      }
      const session = snapshot.threads.find(({ record }) => record.id === action.sessionId)?.record;
      if (session === undefined) throw new Error("Selected worker is no longer available");
      state = {
        ...state,
        notice: await runtime.openWorktree(session, {
          enabled: state.nvimLayoutEnabled,
          orchestratorSessionIds: layoutOrchestratorSessionIds(snapshot),
        }),
        noticeTone: "neutral",
      };
    } else if (action?.type === "open-checkout") {
      if (runtime.openCheckout === undefined) {
        throw new Error("nvim worktree navigation is unavailable in this client");
      }
      state = {
        ...state,
        notice: await runtime.openCheckout(
          action.cwd,
          {
            enabled: state.nvimLayoutEnabled,
            orchestratorSessionIds: layoutOrchestratorSessionIds(snapshot),
          },
          // Every thread, not the folder's own rows: which of them is running *in* the checkout is
          // the open's question to answer, and it answers it from the same truth Fleet renders.
          snapshot.threads.map(({ record }) => record),
        ),
        noticeTone: "neutral",
      };
    } else if (action?.type === "attach-clipboard-image") {
      const image = await pasteboardImage();
      if (image.status === "captured") {
        const target = state.launchProfiles[composerCwd(state, snapshot)]?.provider;
        if (target !== undefined && !providerAcceptsImages(target)) {
          // Only reachable when the profile changed between the chord and the capture. The file
          // is on disk either way; what it must not do is enter a draft bound for a CLI that
          // will read it as words.
          state = { ...state, notice: imageInputRefusal(target), noticeTone: "error" };
        } else {
          // The notice names the mechanism, not just the file. A path Claude opens with its file
          // reader and a path Codex attaches with `-i` are both honest deliveries and are not the
          // same delivery, and the operator is the one who has to know which they just got.
          state = {
            ...state,
            draft: draftWithImageReference(state.draft, image.path),
            notice: `Attached ${basename(image.path)} — ${target === undefined ? "worker not chosen yet" : providerImageMechanism(target)
              }`,
            noticeTone: "neutral",
          };
        }
      } else if (image.status === "unavailable") {
        // The pasteboard was never read, so whether it held a screenshot is unknown. Saying so is
        // the whole point: the quiet branch below is for a pasteboard that answered "nothing".
        state = {
          ...state,
          notice: `Could not read the clipboard: ${image.reason}`,
          noticeTone: "error",
        };
      }
    } else if (action?.type === "project-add") {
      const result = await client.request<FleetProjectAddResult>("fleet.project.add", {
        path: action.path,
        ...(action.acceptParent === true ? { acceptParent: true } : {}),
      });
      if (result.status === "worktree") {
        // Nothing was written. The prompt comes back holding the broker's answer so Enter means
        // the repository, and any other key means the operator is still typing.
        state = {
          ...state,
          projectPrompt: {
            draft: action.path,
            parentOffer: { root: result.root, toplevel: result.toplevel },
          },
          notice: `${shortPath(result.toplevel, renderOptions.home)} is a worktree of ${shortPath(result.root, renderOptions.home)} — enter registers the repository, esc cancels`,
          noticeTone: "confirmation",
        };
      } else {
        snapshot = await collectFleetSnapshot(client);
        state = {
          ...state,
          notice: result.alreadyRegistered
            ? `Already a project: ${shortPath(result.root, renderOptions.home)}`
            : `Registered project ${shortPath(result.root, renderOptions.home)}`,
          noticeTone: "neutral",
        };
      }
    } else if (action?.type === "project-remove") {
      const result = await client.request<FleetProjectRemoveResult>("fleet.project.remove", {
        path: action.root,
      });
      snapshot = await collectFleetSnapshot(client);
      state = {
        ...state,
        notice: result.removed
          ? `Removed project ${shortPath(result.root, renderOptions.home)} — its threads are now unregistered`
          : `Not a registered project: ${shortPath(result.root, renderOptions.home)}`,
        noticeTone: result.removed ? "neutral" : "warning",
      };
    } else if (action?.type === "project-complete") {
      const completion = await completeDirectoryPath(action.draft, {
        cwd: composerCwd(state, snapshot),
        home: renderOptions.home,
      });
      state = {
        ...state,
        projectPrompt: { draft: completion.value },
        // Several matches are worth showing; one is already in the draft.
        notice: completion.candidates.length > 1
          ? completion.candidates.slice(0, 12).join("  ")
          : undefined,
        noticeTone: "neutral",
      };
    } else if (action?.type === "shell-run") {
      if (runtime.runShellCommand === undefined) {
        throw new Error("Shell mode is unavailable in this Fleet client");
      }
      const abort = new AbortController();
      context.setShellInterrupt(abort);
      const result = await runtime.runShellCommand({
        command: action.command,
        cwd: action.cwd,
        signal: abort.signal,
        // Output is folded into the transcript as it arrives and the frame is woken for each
        // chunk, so a slow command shows its progress rather than landing all at once.
        onOutput: (chunk) => {
          const shell = state.shellMode;
          if (shell === undefined) return;
          state = {
            ...state,
            shellMode: { ...shell, transcript: appendShellOutput(shell.transcript, chunk) },
          };
          context.updateState(state);
          context.notify();
        },
      });
      context.setShellInterrupt(undefined);
      const shell = state.shellMode;
      state = {
        ...state,
        // A `cd` only persists because the shell says where it ended up; when it says nothing,
        // Fleet stays exactly where it was.
        ...(result.cwd === undefined ? {} : { workingDirectory: result.cwd }),
        ...(shell === undefined ? {} : {
          shellMode: {
            ...shell,
            running: false,
            // A failing line says so on a row of its own, whether or not its output ended on a
            // line boundary. A status nobody prints is a status nobody notices.
            transcript: result.exitStatus === 0
              ? shell.transcript
              : appendShellOutput(
                shell.transcript,
                `${(shell.transcript.at(-1) ?? "") === "" ? "" : "\n"}exit ${result.exitStatus}\n`,
              ),
          },
        }),
      };
    } else if (action?.type === "change-directory") {
      if (runtime.changeDirectory === undefined) {
        throw new Error("Working-directory navigation is unavailable in this client");
      }
      const cwd = await runtime.changeDirectory(action.cwd);
      if (cwd !== undefined) {
        state = {
          ...state,
          workingDirectory: cwd,
          notice: `Working directory: ${cwd}`,
          noticeTone: "neutral",
        };
      }
    }
    if (
      action !== undefined
      && action.type !== "attach"
      && action.type !== "resume"
      && action.type !== "start"
      && action.type !== "open-orchestrator"
      && action.type !== "create-orchestrator"
      && action.type !== "change-directory"
      && action.type !== "shell-run"
      && action.type !== "permission-policy"
      && action.type !== "folder-disposition"
      && action.type !== "nvim-layout"
      && action.type !== "delete"
      && action.type !== "open-worktree"
      && action.type !== "open-checkout"
      && action.type !== "attach-clipboard-image"
      && action.type !== "project-add"
      && action.type !== "project-remove"
      && action.type !== "project-complete"
    ) {
      snapshot = await collectFleetSnapshot(client);
    }
  } catch (error) {
    context.setShellInterrupt(undefined);
    state = {
      ...state,
      ...(action?.type === "start" ? { draft: action.request.initialPrompt } : {}),
      // A rejected path is almost always a typo, so the prompt comes back with it still in hand.
      ...(action?.type === "project-add" ? { projectPrompt: { draft: action.path } } : {}),
      // A transport failure is not a definitive handoff result. Restore the exact directive and
      // mutation id so Enter retries the same durable broker mutation rather than duplicating it.
      ...(action?.type === "handoff"
        ? {
          handoffPicker: {
            step: "directive" as const,
            workerIds: action.workerIds,
            recipientSessionId: action.recipientSessionId,
            draft: action.directive,
            mutationId: action.mutationId,
          },
        }
        : {}),
      // A shell that could not be run is still a shell the operator is standing in.
      ...(action?.type === "shell-run" && state.shellMode !== undefined
        ? { shellMode: { ...state.shellMode, running: false } }
        : {}),
      ...(action?.type === "permission-policy"
        ? {
          permissionPolicies: {
            ...state.permissionPolicies,
            [action.provider]: action.previousPolicy,
          },
        }
        : {}),
      notice: error instanceof RpcError && error.code === "METHOD_NOT_FOUND"
        ? "Restart the Cyberdeck broker to enable this fleet action"
        : error instanceof Error ? error.message : String(error),
      noticeTone: "error",
    };
  }

  return { state, snapshot, nvimLayoutHookInstalled };
}
