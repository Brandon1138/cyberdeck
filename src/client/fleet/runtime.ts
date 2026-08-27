import { homedir } from "node:os";
import { join } from "node:path";
import { appStateDirectory } from "../../broker/app-paths.js";
import { attachSession } from "../attach.js";
import { capturePasteboardImage } from "../clipboard-image.js";
import { collectDashboardSnapshot, renderDashboard } from "../dashboard.js";
import { NO_PULL_REQUEST_STATUS, PullRequestStatusCache } from "../pr-status.js";
import { queryTerminalBackground } from "../terminal-background.js";
import { ENTER_FLEET_SCREEN, LEAVE_FLEET_SCREEN, UNREGISTERED_SECTION_KEY } from "./constants.js";
import { FleetKeyDecoder, composerCursor, waitForRefresh } from "./key-decoder.js";
import { normalizeState } from "./normalize.js";
import { clampRowWidth, printedWidth } from "./render-composer.js";
import { normalizeThreadListViewport, renderFleet, threadListViewportHeight } from "./render-frame.js";
import { layoutOrchestratorSessionIds } from "./render-rows.js";
import { executeFleetAction } from "./runtime-actions.js";
import { fleetFrameLayout, readWorkerModels, type FleetFrameLayout, type RetainedFleetFrame } from "./runtime-frame.js";
import { FleetRuntimeOptions, OrchestratorCockpitTarget, ResolvedFleetRenderOptions } from "./runtime-options.js";
import { paint, renderNotice } from "./slash-commands.js";
import { FleetInput, FleetOutput, FleetSignals, FolderDisposition, InteractiveFleetTransport, LaunchProfile } from "./state.js";
import { transitionFleet } from "./transition.js";
import { collectFleetSnapshot, createFleetState } from "./transport.js";
export async function runFleet(
  client: InteractiveFleetTransport,
  input: FleetInput = process.stdin,
  output: FleetOutput = process.stdout,
  signals: FleetSignals = process,
  runtime: FleetRuntimeOptions = {},
): Promise<void> {
  let snapshot = await collectFleetSnapshot(client);
  let state = createFleetState(snapshot);
  const permissionPreferences = runtime.permissionPreferences;
  try {
    state = {
      ...state,
      launchProfiles: await client.request<Record<string, LaunchProfile>>("fleet.preferences", {}),
    };
  } catch {
  }
  try {
    const dispositions = await client.request<Record<string, FolderDisposition>>(
      "fleet.folderDispositions",
      {},
    );
    const keys = Object.entries(dispositions);
    const collapsed = keys.filter(([, disposition]) => disposition.collapsed).map(([key]) => key);
    state = {
      ...state,
      collapsedCwds: dispositions[UNREGISTERED_SECTION_KEY] === undefined
        ? [...collapsed, UNREGISTERED_SECTION_KEY]
        : collapsed,
      expandedCwds: keys.filter(([, disposition]) => disposition.expanded).map(([key]) => key),
    };
  } catch {
  }
  try {
    state = {
      ...state,
      nvimLayoutEnabled: await client.request<boolean>("fleet.nvimLayout", {}),
    };
  } catch {
  }
  if (permissionPreferences !== undefined) try {
    state = {
      ...state,
      permissionPolicies: {
        ...state.permissionPolicies,
        ...await permissionPreferences.list(),
      },
    };
  } catch (error) {
    state = {
      ...state,
      notice: `Could not load permission preferences: ${error instanceof Error ? error.message : String(error)
        }`,
      noticeTone: "error",
    };
  }
  if (input.isTTY !== true) {
    output.write(`${renderFleet(snapshot, state, { color: false, width: output.columns, height: output.rows })}\n`);
    client.close();
    return;
  }
  const terminalBackground = await queryTerminalBackground(input, output);
  state = { ...state, workerModels: await readWorkerModels(client) };
  let nvimLayoutHookInstalled = false;
  if (state.nvimLayoutEnabled && runtime.nvimLayoutHooks !== undefined) {
    try {
      await runtime.nvimLayoutHooks.install(layoutOrchestratorSessionIds(snapshot));
      nvimLayoutHookInstalled = true;
    } catch (error) {
      state = {
        ...state,
        notice: `Could not install automatic nvim layout: ${error instanceof Error ? error.message : String(error)
          }`,
        noticeTone: "error",
      };
    }
  }
  const pullRequestStatus = runtime.pullRequestStatus
    ?? (output.isTTY === true ? new PullRequestStatusCache() : NO_PULL_REQUEST_STATUS);
  const pasteboardImage = runtime.pasteboardImage
    ?? (() => capturePasteboardImage({ directory: join(appStateDirectory, "pasted-images") }));
  const previousRawMode = input.isRaw === true;
  let paintedFrame: RetainedFleetFrame | undefined;
  const enterFleetScreen = () => {
    output.write(ENTER_FLEET_SCREEN);
    paintedFrame = undefined;
  };
  const writeFrame = (
    body: string,
    cursor: { row: number; column: number; } | undefined,
    layout: FleetFrameLayout,
  ) => {
    const renderedRows = body.split("\n");
    const maximumFirstRow = Math.max(0, renderedRows.length - layout.height);
    const firstRow = cursor === undefined
      ? 0
      : Math.min(maximumFirstRow, Math.max(0, cursor.row - layout.height));
    const rows = renderedRows
      .slice(firstRow, firstRow + layout.height)
      .map((row) => clampRowWidth(row, layout.width));
    const frameCursor = cursor !== undefined
      && cursor.row > firstRow
      && cursor.row <= firstRow + rows.length
      ? {
        row: cursor.row - firstRow,
        column: Math.max(1, Math.min(cursor.column, layout.width)),
      }
      : undefined;
    const retainedLayout = {
      ...layout,
      scrollOffset: JSON.stringify([layout.scrollOffset, firstRow]),
    };
    const previous = paintedFrame;
    const dimensionsChanged = previous !== undefined
      && (previous.width !== retainedLayout.width || previous.height !== retainedLayout.height);
    const fullRepaint = previous === undefined
      || dimensionsChanged
      || previous.topology !== retainedLayout.topology
      || previous.scrollOffset !== retainedLayout.scrollOffset
      || previous.rows.length !== rows.length;
    const dirtyRows = fullRepaint
      ? rows.map((_, index) => index)
      : rows.flatMap((row, index) => row === previous.rows[index] ? [] : [index]);
    const cursorUnchanged = previous?.cursor?.row === frameCursor?.row
      && previous?.cursor?.column === frameCursor?.column;
    if (dirtyRows.length === 0 && cursorUnchanged) return;
    const caret = frameCursor === undefined
      ? ""
      : `\u001b[${frameCursor.row};${frameCursor.column}H\u001b[?25h`;
    const paintRow = (row: string) =>
      printedWidth(row) < layout.width ? `${row}\u001b[K` : row;
    let damage: string;
    if (fullRepaint) {
      const clear = previous === undefined || dimensionsChanged ? "\u001b[2J" : "";
      const below = !dimensionsChanged && previous !== undefined && previous.rows.length > rows.length
        ? `\u001b[${rows.length + 1};1H\u001b[0J`
        : "";
      damage = `${clear}\u001b[H${rows.map(paintRow).join("\n")}${below}`;
    } else {
      damage = dirtyRows
        .map((index) => `\u001b[${index + 1};1H${paintRow(rows[index]!)}`)
        .join("");
    }
    output.write(`\u001b[?25l${damage}${caret}`);
    paintedFrame = { ...retainedLayout, rows, cursor: frameCursor };
  };
  let stopped = false;
  let attaching = false;
  let wake: (() => void) | undefined;
  let wakePending = false;
  let inputQueue = Promise.resolve();
  const keyDecoder = new FleetKeyDecoder();
  let decoderFlushTimer: ReturnType<typeof setTimeout> | undefined;
  let shellInterrupt: AbortController | undefined;
  const notify = () => {
    if (wake === undefined) {
      wakePending = true;
      return;
    }
    wake();
  };
  const waitForNextFrame = () => waitForRefresh(
    (resume) => {
      if (wakePending) {
        wakePending = false;
        resume();
      } else {
        wake = resume;
      }
    },
    () => { wake = undefined; },
  );
  const stop = () => {
    stopped = true;
    if (attaching) client.close();
    notify();
  };
  const unsubscribeClose = client.onClose(stop);
  const openNativeThread = async (sessionId: string) => {
    attaching = true;
    notify();
    keyDecoder.reset();
    if (decoderFlushTimer !== undefined) clearTimeout(decoderFlushTimer);
    input.off("data", onInput);
    input.pause?.();
    input.setRawMode?.(false);
    output.write(`${LEAVE_FLEET_SCREEN}\u001b[2J\u001b[H`);
    try {
      const status = await attachSession({
        sessionId,
        mode: "control",
        transport: client,
        input,
        output,
        signals,
        closeTransport: false,
        ...(runtime.detachIdentity === undefined ? {} : { detachIdentity: runtime.detachIdentity }),
      });
      if (status !== 0) state = { ...state, notice: "Provider attachment closed unexpectedly", noticeTone: "error" };
    } catch (error) {
      state = { ...state, notice: error instanceof Error ? error.message : String(error), noticeTone: "error" };
    } finally {
      attaching = false;
      if (!stopped) {
        input.setRawMode?.(true);
        input.on("data", onInput);
        input.resume?.();
        enterFleetScreen();
        snapshot = await collectFleetSnapshot(client);
      }
      notify();
    }
  };
  const openOrchestrator = async (target: OrchestratorCockpitTarget) => {
    if (runtime.openOrchestrator === undefined) {
      throw new Error("Orchestrator cockpit presentation is unavailable in this client");
    }
    attaching = true;
    notify();
    keyDecoder.reset();
    if (decoderFlushTimer !== undefined) clearTimeout(decoderFlushTimer);
    input.off("data", onInput);
    input.pause?.();
    input.setRawMode?.(false);
    output.write(`${LEAVE_FLEET_SCREEN}\u001b[2J\u001b[H`);
    try {
      const session = await runtime.openOrchestrator(target);
      state = { ...state, selectedSessionId: session.id, notice: undefined };
      if (nvimLayoutHookInstalled) {
        await runtime.nvimLayoutHooks?.rebalance(
          layoutOrchestratorSessionIds(snapshot, session.id),
        );
      }
    } finally {
      attaching = false;
      if (!stopped) {
        input.setRawMode?.(true);
        input.on("data", onInput);
        input.resume?.();
        enterFleetScreen();
        snapshot = await collectFleetSnapshot(client);
      }
      notify();
    }
  };
  const perform = async (key: string) => {
    const width = Math.max(1, output.columns ?? 120);
    const height = Math.max(1, output.rows ?? 32);
    const renderOptions: ResolvedFleetRenderOptions = {
      color: output.isTTY === true,
      width,
      height,
      now: Date.now(),
      home: homedir(),
      pullRequests: pullRequestStatus.states(),
      background: terminalBackground,
    };
    state = normalizeThreadListViewport(snapshot, state, renderOptions);
    const transition = transitionFleet(
      state,
      snapshot,
      key,
      renderOptions.now,
      threadListViewportHeight(snapshot, state, renderOptions),
    );
    state = transition.state;
    const action = transition.action;
    if (action?.type === "quit") {
      stop();
      return;
    }
    const executed = await executeFleetAction({
      client,
      runtime,
      permissionPreferences,
      pasteboardImage,
      renderOptions,
      state,
      snapshot,
      action,
      nvimLayoutHookInstalled,
      openNativeThread: async (sessionId, currentState) => {
        state = currentState;
        await openNativeThread(sessionId);
        return { state, snapshot };
      },
      openOrchestrator: async (target, currentState, currentSnapshot, layoutInstalled) => {
        state = currentState;
        snapshot = currentSnapshot;
        nvimLayoutHookInstalled = layoutInstalled;
        await openOrchestrator(target);
        return { state, snapshot, nvimLayoutHookInstalled };
      },
      setShellInterrupt: (interrupt) => { shellInterrupt = interrupt; },
      updateState: (currentState) => { state = currentState; },
      notify,
    });
    state = executed.state;
    snapshot = executed.snapshot;
    nvimLayoutHookInstalled = executed.nvimLayoutHookInstalled;
    notify();
  };
  const queueKeys = (keys: readonly string[]) => {
    if (
      shellInterrupt !== undefined
      && keys.some((key) => key === "ctrl+g" || key === "escape" || key === "ctrl+c")
    ) {
      shellInterrupt.abort();
    }
    for (const key of keys) inputQueue = inputQueue.then(() => perform(key));
  };
  const onInput = (value: Buffer | string) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    queueKeys(keyDecoder.push(bytes));
    if (decoderFlushTimer !== undefined) clearTimeout(decoderFlushTimer);
    if (keyDecoder.hasPendingInput) {
      decoderFlushTimer = setTimeout(() => {
        decoderFlushTimer = undefined;
        queueKeys(keyDecoder.flush());
      }, 25);
    }
  };
  input.setRawMode?.(true);
  input.on("data", onInput);
  input.resume?.();
  const onSigint = () => { queueKeys(["ctrl+c"]); };
  const onResize = () => {
    paintedFrame = undefined;
    notify();
  };
  signals.on("SIGINT", onSigint);
  signals.on("SIGTERM", stop);
  signals.on("SIGWINCH", onResize);
  enterFleetScreen();
  try {
    while (!stopped) {
      if (attaching) {
        await waitForNextFrame();
        continue;
      }
      snapshot = await collectFleetSnapshot(client);
      state = normalizeState(state, snapshot, Date.now());
      pullRequestStatus.refresh(snapshot.threads.map(({ record }) => ({
        threadId: record.id,
        cwd: record.cwd,
        ...(record.workspace?.branch === undefined ? {} : { branch: record.workspace.branch }),
      })));
      const height = Math.max(1, output.rows ?? 32);
      const width = Math.max(1, output.columns ?? 120);
      if (state.view === "diagnostics") {
        const dashboard = await collectDashboardSnapshot(client);
        const diagnostics = renderDashboard(dashboard).split("\n");
        const footer = [
          ...(state.notice === undefined ? [] : [renderNotice(state.notice, state.noticeTone, width, output.isTTY === true)]),
          paint("─".repeat(width), "dim", output.isTTY === true),
          "ctrl+w Fleet · ctrl+c twice to exit",
        ];
        const body = diagnostics.slice(0, Math.max(0, height - footer.length));
        while (body.length < height - footer.length) body.push("");
        writeFrame([...body, ...footer].join("\n"), undefined, {
          width,
          height,
          scrollOffset: "diagnostics",
          topology: JSON.stringify({
            surface: "diagnostics",
            footerRows: footer.length,
            sourceRows: Math.min(diagnostics.length, body.length),
            sessions: dashboard.sessions.map(({ id }) => id),
            jobs: dashboard.jobs.map(({ record }) => record.id),
            queue: dashboard.queue === null
              ? null
              : dashboard.queue.queued.map(({ jobId }) => jobId),
            budget: dashboard.budget === null
              ? null
              : dashboard.budget.scopes.map(({ scopeId, usage }) => [
                scopeId,
                usage.jobsWithUnknownUsage > 0,
              ]),
            reconciliation: dashboard.reconciliation === null
              ? null
              : {
                ran: dashboard.reconciliation.reconciledAt !== null,
                findings: dashboard.reconciliation.findings.map(({ kind, subject }) =>
                  `${kind}:${subject}`),
              },
          }),
        });
      } else {
        const renderOptions: ResolvedFleetRenderOptions = {
          color: output.isTTY === true,
          width,
          height,
          now: Date.now(),
          home: homedir(),
          pullRequests: pullRequestStatus.states(),
          background: terminalBackground,
        };
        state = normalizeThreadListViewport(snapshot, state, renderOptions);
        const rendered = renderFleet(snapshot, state, renderOptions);
        writeFrame(
          rendered,
          composerCursor(rendered, state, width),
          fleetFrameLayout(snapshot, state, renderOptions),
        );
      }
      await waitForNextFrame();
    }
    await inputQueue;
  } finally {
    let layoutCleanupError: unknown;
    try {
      if (nvimLayoutHookInstalled) await runtime.nvimLayoutHooks?.remove();
    } catch (error) {
      layoutCleanupError = error;
    }
    unsubscribeClose();
    signals.off("SIGINT", onSigint);
    signals.off("SIGTERM", stop);
    signals.off("SIGWINCH", onResize);
    input.off("data", onInput);
    input.pause?.();
    input.setRawMode?.(previousRawMode);
    if (decoderFlushTimer !== undefined) clearTimeout(decoderFlushTimer);
    output.write(LEAVE_FLEET_SCREEN);
    client.close();
    if (layoutCleanupError !== undefined) throw layoutCleanupError;
  }
}
