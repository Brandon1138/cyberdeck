import type { SessionRecord } from "../../domain/session.js";
import { CONFIGURABLE_PERMISSION_PROVIDERS, permissionProviderLabel, resolveProviderPermission, type ConfigurablePermissionProvider, type ProviderPermissionPolicy } from "../permission-policy.js";
import { COMMAND_PALETTE_VISIBLE_ROWS, DEFAULT_PERMISSION_POLICIES, PERMISSION_POLICIES, SLASH_COMMANDS } from "./constants.js";
import { composerCwd } from "./model-labels.js";
import { openHandoffPicker } from "./picker-handoff.js";
import { pickerRow, renderCursorlessPickerFrame } from "./picker-orchestrator.js";
import { openWorkerPicker } from "./picker-worker.js";
import { fit, renderComposerLines } from "./render-composer.js";
import { renderHeader } from "./render-list.js";
import { boundedIndex } from "./render-rows.js";
import { ResolvedFleetRenderOptions, SlashCommandDefinition, SlashCommandValue } from "./runtime-options.js";
import { paint, renderNotice, workerPolicyTransition } from "./slash-commands.js";
import { FleetSnapshot, FleetState, FleetTransition } from "./state.js";

export function transitionCommandPalette(
  state: FleetState,
  snapshot: FleetSnapshot,
  key: string,
): FleetTransition {
  const palette = state.commandPalette!;
  const candidates = commandPaletteCandidates(state);
  if (key === "escape") {
    return {
      state: {
        ...state,
        draft: "",
        commandPalette: undefined,
        notice: undefined,
      },
    };
  }
  if (key === "up" || key === "down") {
    const delta = key === "up" ? -1 : 1;
    const selectedIndex = boundedIndex(
      palette.selectedIndex + delta,
      candidates.length,
    );
    return {
      state: {
        ...state,
        commandPalette: {
          ...palette,
          selectedIndex,
          scrollOffset: paletteScrollOffset(selectedIndex, palette.scrollOffset),
        },
      },
    };
  }
  if (key === "backspace") {
    if (state.draft === "/") {
      return {
        state: {
          ...state,
          draft: "",
          commandPalette: undefined,
          notice: undefined,
        },
      };
    }
    const draft = [...state.draft].slice(0, -1).join("");
    const command = palette.command;
    const valuesOpen = command !== undefined && draft.startsWith(`${command} `);
    return {
      state: {
        ...state,
        draft,
        commandPalette: {
          level: valuesOpen ? "values" : "commands",
          ...(valuesOpen ? { command } : {}),
          selectedIndex: 0,
          scrollOffset: 0,
        },
        notice: undefined,
      },
    };
  }
  if (key === "enter") {
    const selected = candidates[palette.selectedIndex];
    if (selected === undefined) {
      return {
        state: {
          ...state,
          notice: "No matching slash commands",
          noticeTone: "error",
        },
      };
    }
    if (palette.level === "commands") {
      const command = selected as SlashCommandDefinition;
      if (command.values !== undefined) {
        return {
          state: {
            ...state,
            draft: `${command.name} `,
            commandPalette: {
              level: "values",
              command: command.name,
              selectedIndex: 0,
              scrollOffset: 0,
            },
            notice: undefined,
          },
        };
      }
      const closed = {
        ...state,
        draft: "",
        commandPalette: undefined,
        notice: undefined,
      };
      if (command.name === "/model") return openWorkerPicker(closed, snapshot, "");
      if (command.name === "/handoff") return openHandoffPicker(closed, snapshot);
      return openPermissionPicker(closed, snapshot);
    }
    const command = palette.command!;
    const value = (selected as SlashCommandValue).value;
    const completed = {
      ...state,
      draft: `${command} ${value}`,
      commandPalette: undefined,
      notice: undefined,
    };
    return workerPolicyTransition(completed, snapshot, completed.draft)
      ?? { state: completed };
  }
  if ([...key].length === 1 && key.charCodeAt(0) >= 0x20) {
    if (palette.level === "commands" && key === " ") {
      const command = SLASH_COMMANDS.find((candidate) => candidate.name === state.draft);
      if (command?.values !== undefined) {
        return {
          state: {
            ...state,
            draft: `${state.draft} `,
            commandPalette: {
              level: "values",
              command: command.name,
              selectedIndex: 0,
              scrollOffset: 0,
            },
            notice: undefined,
          },
        };
      }
    }
    return {
      state: {
        ...state,
        draft: `${state.draft}${key}`,
        commandPalette: {
          ...palette,
          selectedIndex: 0,
          scrollOffset: 0,
        },
        notice: undefined,
      },
    };
  }
  return { state };
}

export function commandPaletteCandidates(
  state: FleetState,
): readonly (SlashCommandDefinition | SlashCommandValue)[] {
  const palette = state.commandPalette!;
  if (palette.level === "commands") {
    const query = state.draft.slice(1).trim().toLowerCase();
    if (query === "") return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((command) =>
      command.name.slice(1).includes(query)
      || command.description.toLowerCase().includes(query));
  }
  const command = SLASH_COMMANDS.find((candidate) => candidate.name === palette.command);
  if (command?.values === undefined) return [];
  const prefix = `${command.name} `;
  const query = state.draft.startsWith(prefix)
    ? state.draft.slice(prefix.length).trim().toLowerCase()
    : "";
  if (query === "") return command.values;
  return command.values.filter((value) =>
    value.value.includes(query)
    || value.description.toLowerCase().includes(query));
}

export function paletteScrollOffset(selectedIndex: number, current: number): number {
  if (selectedIndex < current) return selectedIndex;
  if (selectedIndex >= current + COMMAND_PALETTE_VISIBLE_ROWS) {
    return selectedIndex - COMMAND_PALETTE_VISIBLE_ROWS + 1;
  }
  return current;
}

export function renderCommandPalette(
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string {
  const palette = state.commandPalette!;
  const candidates = commandPaletteCandidates(state);
  const visible = candidates.slice(
    palette.scrollOffset,
    palette.scrollOffset + COMMAND_PALETTE_VISIBLE_ROWS,
  );
  const lines = [
    ...renderHeader([], state, options),
    "",
    palette.level === "commands" ? "Slash commands" : `${palette.command} values`,
    "",
  ];
  if (visible.length === 0) {
    lines.push("No matching commands");
  } else {
    lines.push(...visible.map((candidate, visibleIndex) => {
      const absoluteIndex = palette.scrollOffset + visibleIndex;
      const label = "name" in candidate ? candidate.name : candidate.value;
      return pickerRow(
        fit(`${label}  ${candidate.description}`, options.width - 2),
        absoluteIndex === palette.selectedIndex,
        options.color,
      );
    }));
  }
  const range = candidates.length === 0
    ? "0 results"
    : `${palette.scrollOffset + 1}-${Math.min(
      candidates.length,
      palette.scrollOffset + COMMAND_PALETTE_VISIBLE_ROWS,
    )} of ${candidates.length}`;
  const footer = [
    paint("─".repeat(options.width), "dim", options.color),
    ...renderComposerLines(state.draft, "task", options),
    paint("─".repeat(options.width), "dim", options.color),
    paint(fit(`↑↓ select · enter complete · esc close · ${range}`, options.width), "dim", options.color),
  ];
  const body = lines.slice(0, Math.max(0, options.height - footer.length));
  while (body.length < options.height - footer.length) body.push("");
  return [...body, ...footer].join("\n");
}

export function openPermissionPicker(
  state: FleetState,
  snapshot: FleetSnapshot,
): FleetTransition {
  const provider = state.launchProfiles[composerCwd(state, snapshot)]?.provider;
  const providerIndex = Math.max(
    0,
    CONFIGURABLE_PERMISSION_PROVIDERS.indexOf(
      provider as ConfigurablePermissionProvider,
    ),
  );
  return {
    state: {
      ...state,
      draft: "",
      commandPalette: undefined,
      permissionPicker: {
        step: "provider",
        providerIndex,
        policyIndex: 0,
      },
      helpOpen: false,
      notice: undefined,
    },
  };
}

export function transitionPermissionPicker(
  state: FleetState,
  snapshot: FleetSnapshot,
  key: string,
): FleetTransition {
  const picker = state.permissionPicker!;
  if (key === "escape") {
    if (picker.step === "policy") {
      return {
        state: {
          ...state,
          permissionPicker: { ...picker, step: "provider" },
          notice: undefined,
        },
      };
    }
    return {
      state: {
        ...state,
        permissionPicker: undefined,
        draft: "",
        notice: undefined,
      },
    };
  }
  if (key === "up" || key === "down") {
    const delta = key === "up" ? -1 : 1;
    return {
      state: {
        ...state,
        permissionPicker: picker.step === "provider"
          ? {
            ...picker,
            providerIndex: boundedIndex(
              picker.providerIndex + delta,
              CONFIGURABLE_PERMISSION_PROVIDERS.length,
            ),
          }
          : {
            ...picker,
            policyIndex: boundedIndex(
              picker.policyIndex + delta,
              PERMISSION_POLICIES.length,
            ),
          },
        notice: undefined,
      },
    };
  }
  if (key !== "enter") return { state };
  const provider = CONFIGURABLE_PERMISSION_PROVIDERS[picker.providerIndex]!;
  if (picker.step === "provider") {
    const currentPolicy = permissionPolicy(state, provider);
    return {
      state: {
        ...state,
        permissionPicker: {
          ...picker,
          step: "policy",
          policyIndex: PERMISSION_POLICIES.indexOf(currentPolicy),
        },
        notice: undefined,
      },
    };
  }
  const policy = PERMISSION_POLICIES[picker.policyIndex]!;
  const sandbox = permissionSandbox(state, snapshot);
  const resolved = resolveProviderPermission(provider, policy, sandbox);
  if (!resolved.ok) {
    return {
      state: {
        ...state,
        notice: resolved.message,
        noticeTone: "error",
      },
    };
  }
  const previousPolicy = permissionPolicy(state, provider);
  return {
    state: {
      ...state,
      permissionPicker: undefined,
      permissionPolicies: {
        ...state.permissionPolicies,
        [provider]: policy,
      },
      notice: `${permissionProviderLabel(provider)} permissions: ${resolved.value.nativeMode}`,
      noticeTone: "neutral",
    },
    action: {
      type: "permission-policy",
      provider,
      policy,
      previousPolicy,
    },
  };
}

export function renderPermissionPicker(
  snapshot: FleetSnapshot,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string {
  const picker = state.permissionPicker!;
  const sandbox = permissionSandbox(state, snapshot);
  const provider = CONFIGURABLE_PERMISSION_PROVIDERS[picker.providerIndex]!;
  const lines = [...renderHeader([], state, options), ""];
  if (picker.step === "provider") {
    lines.push("Provider permissions", "");
    lines.push(...CONFIGURABLE_PERMISSION_PROVIDERS.map((candidate, index) => {
      const policy = permissionPolicy(state, candidate);
      const resolved = resolveProviderPermission(candidate, policy, sandbox);
      const nativeMode = resolved.ok ? resolved.value.nativeMode : "unsupported";
      return pickerRow(
        `${permissionProviderLabel(candidate)}  ${policy} · ${nativeMode}`,
        index === picker.providerIndex,
        options.color,
      );
    }));
  } else {
    lines.push(`${permissionProviderLabel(provider)} permission policy`, "");
    lines.push(...PERMISSION_POLICIES.map((policy, index) => {
      const resolved = resolveProviderPermission(provider, policy, sandbox);
      const description = resolved.ok
        ? `${resolved.value.nativeMode}${resolved.value.launchArguments.length === 0
          ? ""
          : ` · ${resolved.value.launchArguments.join(" ")}`}`
        : `unsupported · ${resolved.message}`;
      return pickerRow(
        `${policy}  ${description}`,
        index === picker.policyIndex,
        options.color,
      );
    }));
  }
  const footer = [
    ...(state.notice === undefined
      ? []
      : [renderNotice(state.notice, state.noticeTone, options.width, options.color)]),
    paint("─".repeat(options.width), "dim", options.color),
    paint(
      fit("↑↓ select · enter inspect/apply · esc back", options.width),
      "dim",
      options.color,
    ),
  ];
  return renderCursorlessPickerFrame(
    lines,
    footer,
    options.height,
    state.notice === undefined ? 0 : 1,
  );
}

export function permissionPolicy(
  state: FleetState,
  provider: ConfigurablePermissionProvider,
): ProviderPermissionPolicy {
  return state.permissionPolicies[provider] ?? DEFAULT_PERMISSION_POLICIES[provider];
}

export function permissionSandbox(
  state: FleetState,
  snapshot: FleetSnapshot,
): SessionRecord["sandbox"] {
  return snapshot.threads.find(({ record }) =>
    record.id === state.selectedSessionId)?.record.sandbox ?? "read-only";
}

