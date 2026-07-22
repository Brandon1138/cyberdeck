---
name: Cyberdeck Fleet
description: A restrained terminal register for durable, provider-neutral agent sessions.
colors:
  primary: "#9EB6FF"
  logo: "#B69EFF"
  canvas: "#0E1116"
  surface: "#151922"
  text-strong: "#D7DCE4"
  text-muted: "#7B8490"
  divider: "#343B46"
  state-working: "#66C2D0"
  state-needs-input: "#D4A85B"
  state-done: "#78C679"
  state-failed: "#D96C75"
  state-stopped: "#7B8490"
typography:
  title:
    fontFamily: "terminal monospace"
    fontSize: "1em"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "normal"
  body:
    fontFamily: "terminal monospace"
    fontSize: "1em"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "normal"
  label:
    fontFamily: "terminal monospace"
    fontSize: "1em"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "normal"
spacing:
  cell: "1ch"
  pair: "2ch"
  group: "4ch"
components:
  logo-mark:
    textColor: "{colors.logo}"
    typography: "{typography.body}"
    width: "8ch"
    height: "3em"
  header-title:
    textColor: "{colors.text-strong}"
    typography: "{typography.title}"
  project-heading:
    textColor: "{colors.primary}"
    typography: "{typography.label}"
  thread-selected:
    textColor: "{colors.text-strong}"
    typography: "{typography.title}"
  thread-preview:
    textColor: "{colors.text-muted}"
    typography: "{typography.body}"
  state-working:
    textColor: "{colors.state-working}"
    typography: "{typography.label}"
  state-needs-input:
    textColor: "{colors.state-needs-input}"
    typography: "{typography.label}"
  state-done:
    textColor: "{colors.state-done}"
    typography: "{typography.label}"
  state-failed:
    textColor: "{colors.state-failed}"
    typography: "{typography.label}"
  state-stopped:
    textColor: "{colors.state-stopped}"
    typography: "{typography.label}"
  composer:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text-strong}"
    typography: "{typography.body}"
---

# Design System: Cyberdeck Fleet

## Overview

**Creative North Star: "The Durable Register"**

A developer returns to a dim terminal after several agents have worked across multiple repositories. The interface must reveal what changed, what needs intervention, and what can be reopened without making the user decode a dashboard. This physical scene requires a dark, quiet canvas, strong text hierarchy, dense rows, and restrained semantic color.

Fleet is a provider-neutral register of durable conversations. It follows the proven Claude Code Fleet interaction pattern while changing the parts that would lie about ownership, lifecycle, or model choice. The broker owns runtimes, tmux owns presentation, and every row represents a conversation that remains visible after detachment or broker restart. A lost runtime becomes `Interrupted`; its thread does not vanish and reopening it resumes the exact provider-native conversation when possible.

The interface is keyboard-first and structurally simple: one header, project groups, conversation rows, and one bottom composer. It has no speculative panels, ornamental terminal chrome, provider rankings, or hidden fallback. Mouse and hover behavior are outside the current implementation scope, and no action may depend on either.

**Key Characteristics:**

- Durable project and thread grouping that survives Fleet and broker restarts.
- Attention states that describe what the user must do, not merely whether a PTY exists.
- Compact model, effort, status, assistant preview, and age information.
- A fixed upper-left logo bay for a later 8-bit Cyberdeck mark.
- Explicit model selection through `/model`, followed only by effort.
- Familiar terminal controls with complete text labels and reduced-color fallbacks.

**The Conversation Rule.** A Fleet row is a durable conversation, not a transient process. Runtime loss changes its status; it never deletes the row.

**The One Surface Rule.** Fleet stays a single task register. Diagnostics remain a separate view and never grow into panels inside Fleet.

## Colors

The palette is cool graphite with one pale signal-blue accent. Semantic cyan, amber, green, and red appear only where state requires them.

### Primary

- **Signal Blue** (`#9EB6FF`): selected markers, project paths, active picker rows, and the composer mode indicator. It occupies less than ten percent of the screen and never fills an entire thread row.
- **Octo Violet** (`#B69EFF`): the 8-bit octopus logo mark in the header bay, and nothing else. It carries no state meaning and never appears in rows, pickers, or copy.

### Neutral

- **Ink Slate** (`#0E1116`): intended canvas for renderers that own their background. Terminal clients may preserve the user's equivalent dark background.
- **Deep Slate** (`#151922`): optional footer or inline-picker surface. It is never used to create nested cards.
- **Frosted Gray** (`#D7DCE4`): primary titles, selected thread names, prompts, and important values.
- **Cool Ash** (`#7B8490`): previews, ages, inactive markers, and stopped states.
- **Steel Hairline** (`#343B46`): footer separators and the tmux pane boundary.

### Semantic

- **Working Cyan** (`#66C2D0`): active generation and tool execution.
- **Attention Amber** (`#D4A85B`): explicit approval, permission, authentication, trust, computer-use enablement, or another blocking question.
- **Completion Green** (`#78C679`): successful completion with no required intervention.
- **Failure Red** (`#D96C75`): failed runtimes, failed turns, destructive confirmation, and error notices only.

**The Sparse Signal Rule.** Color marks selection and state. It never decorates inactive text, paints full project groups, or replaces a written label.

**The Reduced-Color Rule.** Truecolor renderers use the palette above. Sixteen-color terminals map primary to blue, working to cyan, needs input to yellow, done to green, failed to red, and muted content to bright black. Every state remains readable without color.

## Typography

**Display Font:** inherited terminal monospace

**Body Font:** inherited terminal monospace

**Label/Mono Font:** inherited terminal monospace

**Character:** Cyberdeck respects the user's terminal font and cell metrics. Hierarchy comes from wording, placement, bold weight, dim weight, and whitespace, never from a decorative display face or simulated pixel font.

### Hierarchy

- **Title** (700, `1em`, line-height `1`): `Cyberdeck`, the selected task title, and active picker choice.
- **Body** (400, `1em`, line-height `1`): task titles, assistant previews, composer text, and help copy.
- **Label** (400, `1em`, line-height `1`): model, effort, status, age, counts, and project path.
- **Muted text** uses normal weight plus the muted color or terminal dim attribute. It never becomes so faint that it disappears on common dark themes.

Title case is the default. `Cyberdeck`, `Needs input`, and friendly model labels are not rendered as shouting uppercase. Canonical provider model IDs may appear in the picker detail line when they prevent ambiguity, but compact rows use stable friendly labels such as `Codex Sol`, `Claude Opus`, or `Gemini Flash`.

**The Fixed Grid Rule.** Do not fake typographic scale with multi-cell glyph art. The 8-bit identity belongs only in the reserved logo bay; operational text stays on the terminal grid.

**The Preview Voice Rule.** Preview copy is the first rendered line of the final substantive paragraph in the latest assistant message. It is not the last terminal line, a cogitation footer, a tool spinner, provider chrome, or `Worked for ...` text.

## Elevation

Cyberdeck is flat. It uses no shadows, blur, glass effects, raised cards, or simulated bevels. Depth comes from one-cell separators, blank rows between project groups, strong versus muted text, and the stable tmux split. The `/model` picker and shortcut panel occupy normal document flow and never appear as floating modal boxes.

The footer uses one dim horizontal separator above the composer and a second separator below it when configuration or help is visible. Project groups use whitespace rather than boxes. The selected row uses an explicit `*` marker and bold task title, not a background slab.

**The Flat Register Rule.** If a section looks like a card, remove the container and restore alignment, whitespace, and a single hairline where separation is necessary.

**The Stable Frame Rule.** State refreshes may replace text in place, but layout does not pulse, animate, or shift for decoration. Cursor behavior and provider output are the only motion.

## Components

### Fleet Header

The header occupies the upper-left of Fleet and establishes identity, current orchestration context, and attention counts.

```text
 ▄████▄   Cyberdeck
▟█▄██▄█▙  Codex Sol · high · ~/code/personal/mikoshi
▌▌▌▌▐▐▐▐  18 agents · 1 needs input · 2 working · 14 done · 1 failed
```

- Reserve an `8ch` by `3-row` logo bay with a `2ch` gap before text. The final 8-bit Cyberdeck logo must fit this box without moving the metadata column.
- The mark is the 8-bit Cyberdeck octopus above, rendered in Octo Violet from half-block and quadrant glyphs: a domed mantle, two notch eyes, and eight one-pixel tentacles. It is the only 8-bit artwork in the interface.
- Render `Cyberdeck` in strong bold text.
- The second line shows the bound orchestrator's friendly model, effort, and scope. The normal global binding is labeled `fleet`; an explicitly isolated workspace binding shows its shortened path. If none exists, show `No orchestrator · ctrl+o to choose` without implying a model default.
- The third line shows total threads plus nonzero attention counts. `Stopped`, `Interrupted`, and `Failed` are never folded into `done`.
- Keep the full logo bay in regular and half-width cockpit panes. Below `64` columns, omit the logo pixels but retain the same header text order.

### Project Groups and Thread Rows

Project headings are shortened canonical working-directory paths in Signal Blue. Groups are separated by one blank row, not rules or boxes. Pinned groups and rows come first; manual ordering is stable and persisted. Unpinned peers use most-recent meaningful activity as the tiebreaker.

The wide row order is fixed:

```text
* Task title                 Codex Sol · high  Working      Latest assistant paragraph…       2m
```

- `*` marks keyboard selection and is paired with a bold title so selection never relies on color.
- The title receives roughly 28 percent of width, model and effort receive at most `20ch`, status receives only its content width up to `11ch`, age receives `5ch`, and preview consumes all remaining space.
- Provider, worker role, sandbox, and raw session ID are not permanent columns. Show provider only as part of an unambiguous friendly model label. Put deeper metadata in thread detail or diagnostics.
- Age is right-aligned and based on the latest meaningful prompt, assistant completion, or lifecycle transition. Selection, attachment, and Fleet refresh do not reset it.
- A renamed title overrides the normalized initial task title and persists across restarts.

At `60` to `99` columns, each thread becomes two dense lines. Model, effort, state, and age remain on the first line; preview begins immediately below the selection indent.

```text
* Create iPhoneDoctor shader…  Opus · high  Done  2m
  iPhone CRT shader background is ready with motion effects…
```

At `50` to `59` columns, model and effort yield before task, state, age, or preview. The second line remains dedicated to preview. Never place a fixed-width identity prefix before preview.

### Attention States

Fleet status is a user-attention state derived from durable conversation state plus live runtime evidence. It is not a direct display of `executionState`.

| Label | Meaning | Treatment |
| --- | --- | --- |
| `Working` | The provider is generating, executing a tool, or starting a turn. | Working Cyan |
| `Needs input` | Progress is blocked on explicit approval, permission, authentication, trust, computer-use enablement, or a blocking question. | Attention Amber |
| `Done` | No work is active and no intervention is required. The last turn completed successfully, or a new zero-turn session is ready. | Completion Green |
| `Stopping` | A stop was requested and provider exit is not yet confirmed. | Attention Amber plus literal label |
| `Stopped` | The user intentionally stopped the runtime; the conversation remains resumable. | Cool Ash |
| `Interrupted` | Broker or runtime ownership was lost without a confirmed user stop. The row remains and may be resumed. | Cool Ash plus literal label |
| `Failed` | The provider or turn ended unexpectedly. | Failure Red |

An active TUI waiting for its next ordinary prompt is `Done`, not `Needs input`. Terminal-title idleness alone is insufficient evidence of a blocking condition. Clean process exit after a successful turn may remain `Done`; a nonzero or protocol-invalid exit is `Failed`.

### Durable Preview and Persistence

- Read previews from normalized assistant transcript events, not from the last visible PTY line.
- Choose the latest assistant message, then its final nonempty substantive paragraph, then that paragraph's first rendered line.
- Exclude reasoning timers, tool output, terminal chrome, status spinners, shortcut hints, and duplicated redraw frames.
- Persist the normalized preview with the thread record so Fleet can render it before any provider runtime is resumed.
- If no assistant message exists, render `No response yet` in Cool Ash. If persistence is unreadable, render `Preview unavailable` and surface the storage error without inventing content.
- Persist the thread index, provider conversation identity, project path, model, effort, title, timestamps, pin and order metadata, last truthful state, and composer configuration. Broker restart must rehydrate the same groups and rows.

### Bottom Composer

The composer is a stable five-row footer at normal height:

```text
────────────────────────────────────────────────────────────────
› Describe a task for a new session
────────────────────────────────────────────────────────────────
▶ Claude Opus · high · read-only · ~/code/personal/mikoshi
enter open/start · space reply · /model configure · ? shortcuts
```

- Empty composer plus `Enter` opens the selected thread. Nonempty composer plus `Enter` starts a new worker with the visible model, effort, sandbox, and project context.
- `Space` from an empty composer enters reply mode for the selected thread. Reply mode names its target and does not change the new-worker configuration.
- `Ctrl+J` inserts a newline. `Esc` leaves reply, rename, or picker mode before it can clear a draft; from the base view it does nothing and never exits Fleet.
- If no explicit new-worker model has been selected, the context line reads `▶ /model required · read-only · <project>`, and submission opens the picker instead of starting anything.
- Persist the last explicit model and effort per project. Selecting a thread never silently rewrites this configuration.
- Notices appear directly above the first separator. Errors are red; neutral confirmations use normal text. No toast or modal is used.

### `/model` Picker

`/model` is the only provider and model configuration flow for new worker creation. The same component is reused wherever an orchestrator model must be chosen.

1. Show one flat list of all currently registered, available models. Each row includes a friendly model name and provider label. Ordering follows stable provider registration and provider-native catalog order, never rank or recommendation.
2. Selecting a model records both its provider and canonical model identifier, then advances to that model's supported effort list.
3. Selecting effort applies immediately, closes the picker, restores the draft, and updates the visible composer context. There is no confirmation step and no generated command preview.

If a provider exposes no effort control, show a single `Provider managed` choice rather than inventing levels. Existing sessions with omitted legacy values may display `native setting`, but new selections never silently fall back. A model-name collision always includes the provider label. Manually selecting Fable and starting a thread is already an explicit human start; do not add a second confirmation screen.

### Shortcut Panel

Pressing `?` with an empty composer expands a help panel in the footer. Pressing `?` again closes it. Within a nonempty draft, `?` remains literal input.

```text
shift+↑↓ reorder   ctrl+s switch views   @ mention          alt+1–9 open   esc back/clear
ctrl+r rename      ctrl+j newline         ctrl+t pin to top  ctrl+x stop   ? close
```

- `Shift+Up/Down` reorders the selected row within its project and persists the order.
- `Ctrl+S` switches between Fleet and Diagnostics without changing provider state.
- `@` inserts a passive thread reference. Mentioning never wakes another agent.
- `Alt+1` through `Alt+9` opens the corresponding visible thread.
- `Ctrl+R` renames the selected thread inline and persists the title.
- `Ctrl+T` toggles pinning at the top of the project group.
- `Ctrl+X` is contextual. Help says `stop` while any selected-tree runtime is live and `delete` only when the full tree is terminal. The visible confirmation must repeat the exact destructive action and descendant count.
- `Esc` backs out of help, an edit, a reply, a picker, or a nonempty draft and never exits Fleet. Two consecutive `Ctrl+C` presses within five seconds exit without stopping agents; the first press shows the only red inline exit confirmation near the footer, and any other key cancels it.
- At narrow widths, wrap the panel into two columns or one column. Never truncate key names or cover thread rows.

### Destructive and Failure Feedback

Stopping and deleting are separate controls. On a live worker, `Ctrl+X` sends stop and changes the row to `Stopping`. On an orchestrator, the same key drains the owned tree and reports literal progress such as `Stopping orchestrator + 3 workers · 2/4 stopped`; repeated presses retry unfinished stops without requiring row hunting. Once the full tree is terminal, the first `Ctrl+X` asks to delete the exact thread or orchestrator plus child-thread count, and the second press within the confirmation window deletes history leaf-first. The confirmation is red; stop progress remains amber.

Failure copy keeps the thread visible, preserves its last assistant preview, and places the exact recoverable next action near the composer. Never translate broker unavailability into an empty Fleet.

## Do's Don'ts

### Do:

- **Do** reserve the `8ch` by `3-row` upper-left bay for the 8-bit octopus mark and render it only in Octo Violet.
- **Do** keep task, friendly model and effort, truthful state, assistant preview, and age visually adjacent.
- **Do** show `Done` when an active provider has completed its turn and awaits an ordinary next prompt.
- **Do** reserve `Needs input` for a concrete blocking intervention and preserve its literal text in reduced-color terminals.
- **Do** rehydrate project groups and threads from durable state after broker restart, marking unverifiable runtime ownership as `Interrupted`.
- **Do** derive previews from the first line of the final substantive paragraph in the latest assistant message.
- **Do** make model selection explicit, visible, and provider-neutral through `/model`, then effort, with no confirmation step.
- **Do** preserve complete keyboard paths for every action and keep standard terminal and tmux behavior intact.
- **Do** let narrow layouts become two-line rows before removing useful content.

### Don't:

- **Don't** build speculative multi-panel dashboards that obscure the active task.
- **Don't** introduce provider-branded behavior, rankings, implicit model choices, or silent fallback.
- **Don't** use decorative terminal interfaces that trade density or keyboard fluency for novelty.
- **Don't** write controls whose label hides whether an action stops a process, detaches a view, or deletes history.
- **Don't** equate provider idleness with `Needs input`, or process exit with the only meaning of `Done`.
- **Don't** delete thread rows when the broker restarts or a PTY cannot be proven alive.
- **Don't** use the last PTY line as preview text, especially when it is a timer, spinner, shortcut, or provider status footer.
- **Don't** spend permanent columns on raw provider IDs, opaque roles, UUIDs, or a `31ch` status field.
- **Don't** use cards, background slabs, gradients, shadows, glass effects, side stripes, animated ornaments, or faux CRT styling.
- **Don't** require mouse, hover, or pointer precision for the current Fleet implementation.
