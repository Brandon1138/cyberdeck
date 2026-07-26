---
name: Cyberdeck Fleet
description: A restrained terminal register for durable, provider-neutral agent sessions.
colors:
  primary: "#9EB6FF"
  logo: "#B69EFF"
  canvas: "#0E1116"
  surface: "#151922"
  text-strong: "#D7DCE4"
  text-muted: "#9AA3AF"
  divider: "#343B46"
  selection: "#9AA3AF"
  state-working: "#A9C6D6"
  state-needs-input: "#D4A85B"
  state-done: "#78C679"
  state-failed: "#D96C75"
  state-stopped: "#9AA3AF"
  pr-open: "#78C679"
  pr-merged: "#C678DD"
  pr-closed: "#9AA3AF"
  pr-failing: "#D96C75"
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

The palette is cool graphite. Color is reserved for state that demands action, plus the single live state; everything else is greyscale, and hierarchy is carried by weight and the selection rule.

### Primary

- **Signal Blue** (`#9EB6FF`): held in reserve. It no longer paints project paths or selected markers, and nothing in Fleet may claim it without a written decision here first.
- **Octo Violet** (`#B69EFF`): the 8-bit octopus logo mark in the header bay, and nothing else. It carries no state meaning and never appears in rows, pickers, or copy. No state may borrow the brand hue — a merged pull request uses Merge Violet instead.

### Neutral

- **Ink Slate** (`#0E1116`): intended canvas for renderers that own their background. Terminal clients may preserve the user's equivalent dark background.
- **Deep Slate** (`#151922`): optional footer or inline-picker surface. It is never used to create nested cards.
- **Frosted Gray** (`#D7DCE4`): the selected thread title, `Cyberdeck`, prompts, and important values.
- **Cool Ash** (`#9AA3AF`): unselected titles, project paths, previews, ages, inactive markers, and every state that is neither live nor actionable — `Stopping`, `Stopped`, `Interrupted`. One contrast step above the former `#7B8490`, which was too faint to read as body text. It is subdued, never foreground-bright.
- **Steel Hairline** (`#343B46`): footer separators and the tmux pane boundary.

### Semantic

- **Attention Amber** (`#D4A85B`): a thread is blocked and wants the operator. It marks `Needs input` alone; approval, permission, authentication, trust, and computer-use prompts all resolve to it. It no longer marks `Done`, because "go read this" and "go unblock this" are different errands and must not share a hue.
- **Failure Red** (`#D96C75`): something is wrong right now — failed runtimes, failed turns, failing checks, destructive confirmation, and error notices. Nothing merely terminal or inert may use it.
- **Merge Violet** (`#C678DD`): a merged pull request. Distinct from Octo Violet so state never borrows the brand.
- **Completion Green** (`#78C679`): `Done` — a thread that finished successfully and is waiting to be read — and an open pull request. Green carries both meanings, in two different columns, and the columns keep them apart.
- **Live Ice** (`#A9C6D6`): `Working`. Brighter than Cool Ash so the one generating thread is findable in a fleet of twenty rows, and cool rather than neutral so it never reads as Frosted Gray.

`Stopping`, `Stopped`, `Interrupted`, a draft or closed pull request, and all model and effort metadata are greyscale. An inert terminal state is not a fault, and metadata is not state. `Working` is the deliberate exception: it demands nothing of the operator, but a live thread is the one thing you need to locate at a glance, and a row that looks exactly like `Stopped` gives you no way to find it.

**The Sparse Signal Rule.** Color marks state that demands action, plus the one live state, and nothing else — four hues in a thread row, everything else greyscale. Selection is carried by the rule and bold weight, not hue. Color never decorates inactive text, paints full project groups, or replaces a written label.

**The Reduced-Color Rule.** Truecolor renderers use the palette above. Sixteen-color terminals map needs input to yellow, done to green, working to cyan, failed to red, merged to magenta, an open pull request to green, and muted content to bright black. The selection rule is a plain glyph and the live marker is a filled `•` against a hollow `·`, so both the focused row and the live thread stay visible with color disabled entirely.

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

The footer uses one dim horizontal separator above the composer and a second separator below it when configuration or help is visible. Project groups use whitespace rather than boxes. The focused row uses a one-cell left rule (`▌`) in the gutter plus a bold title, not a background slab.

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

Project headings are shortened canonical working-directory paths rendered plainly — a path is structure, not state, so it takes no accent. Groups are separated by one blank row, not rules or boxes. Pinned groups and rows come first; manual ordering is stable and persisted. Unpinned peers use most-recent meaningful activity as the tiebreaker.

A project heading is a navigable row of its own. `Up`/`Down` step onto it, `Enter` toggles collapse, and `Left`/`Right` collapse and expand explicitly. A collapsed heading reports how many threads it is hiding and removes them from the navigation model, not merely from the paint. Collapse is view state, held per path for the life of the session.

```text
  ▾ ~/code/personal/cyberdeck
▌ • Task title                 Codex Sol · high  Working      Beginning of latest reply…         2m
  ▸ ~/code/other · 3 threads
```

The row order is fixed at both full and multiplexed widths:

- Every navigable row opens with a two-cell gutter: `▌ ` when focused, two spaces otherwise. Thread titles therefore sit two cells inside their project heading.
- The left rule is the only selection signal that depends on rendering rather than content, and it is a plain glyph, so focus survives `--no-color`. The focused title also goes bold and brighter; unselected titles are Cool Ash.
- `·` marks every thread except a live one, which takes the filled `•`. The marker takes Completion Green for `Done`, Attention Amber for `Needs input`, Failure Red for `Failed`, Live Ice for `Working`, and Cool Ash otherwise. Both glyphs are one cell wide, so the shape change never shifts a column. The status label follows the same color rule, without the glyph.
- The title receives roughly 28 percent of width, model and effort receive at most `20ch`, status receives only its content width up to `11ch`, age receives `5ch`, and preview consumes all remaining space.
- Provider, worker role, sandbox, and raw session ID are not permanent columns. Show provider only as part of an unambiguous friendly model label. Put deeper metadata in thread detail or diagnostics.
- Age is right-aligned and based on the latest meaningful prompt, assistant completion, or lifecycle transition. Selection, attachment, and Fleet refresh do not reset it.
- A renamed title overrides the normalized initial task title and persists across restarts.

At `80` to `99` columns, the same single-line structure is retained with narrower title, identity, and preview columns.

```text
▌ · Create iPhoneDoctor…  Opus · high  Done       Shader background is ready…  2m
```

Below `80` columns, model and effort yield before task, state, age, or preview. The row remains one line so multiplexing does not switch Fleet into a separate compact presentation.

### Attention States

Fleet status is a user-attention state derived from durable conversation state plus live runtime evidence. It is not a direct display of `executionState`.

| Label | Meaning | Treatment |
| --- | --- | --- |
| `Working` | The provider is generating, executing a tool, or starting a turn. | Live Ice plus the filled `•` marker |
| `Needs input` | Progress is blocked on explicit approval, permission, authentication, trust, computer-use enablement, or a blocking question. | Attention Amber |
| `Done` | No work is active and no intervention is required. The last turn completed successfully, or a new zero-turn session is ready. | Completion Green |
| `Stopping` | A stop was requested and provider exit is not yet confirmed. | Cool Ash plus literal label |
| `Stopped` | The user intentionally stopped the runtime; the conversation remains resumable. | Cool Ash |
| `Interrupted` | Broker or runtime ownership was lost without a confirmed user stop. The row remains and may be resumed. | Cool Ash plus literal label |
| `Failed` | The provider or turn ended unexpectedly. | Failure Red |

An active TUI waiting for its next ordinary prompt is `Done`, not `Needs input`. Terminal-title idleness alone is insufficient evidence of a blocking condition. Clean process exit after a successful turn may remain `Done`; a nonzero or protocol-invalid exit is `Failed`.

### Durable Preview and Persistence

- Read previews from normalized assistant transcript events, not from the last visible PTY line.
- Choose the latest assistant message, then continue from the beginning of its first nonempty substantive line.
- Exclude reasoning timers, tool output, terminal chrome, status spinners, shortcut hints, and duplicated redraw frames.
- Persist the normalized preview with the thread record so Fleet can render it before any provider runtime is resumed.
- If no assistant message exists, render `No response yet` in Cool Ash. If persistence is unreadable, render `Preview unavailable` and surface the storage error without inventing content.
- Persist the thread index, provider conversation identity, project path, model, effort, title, timestamps, pin and order metadata, last truthful state, and composer configuration. Broker restart must rehydrate the same groups and rows.

### Bottom Composer

The composer is a stable five-row footer while empty and expands upward as the draft grows:

```text
────────────────────────────────────────────────────────────────
› Describe a task for a new session
────────────────────────────────────────────────────────────────
▶ Claude Opus · high · read-only · cwd ~/code/personal/mikoshi · ctrl+g change
enter open/start · ctrl+g cwd · space reply · /model configure · ? shortcuts
```

- Empty composer plus `Enter` opens the selected thread. Nonempty composer plus `Enter` starts a new worker with the visible model, effort, sandbox, and project context.
- Long logical lines soft-wrap at the pane width. The composer grows upward to one third of the terminal height, capped at twelve visible draft rows; beyond that limit it keeps the newest rows visible and marks hidden earlier content with `…`.
- The full draft remains intact when earlier rows leave the visible composer, and the cursor stays on the final visible wrapped row.
- `Space` from an empty composer enters reply mode for the selected thread. Reply mode names its target and does not change the new-worker configuration.
- `Ctrl+J` inserts a newline. `Esc` leaves reply, rename, or picker mode before it can clear a draft; from the base view it does nothing and never exits Fleet.
- `Ctrl+G` opens a tmux-native, zsh-first working-directory navigator at the draft cwd. Tab remains unbound in Fleet and retains its native shell-completion role inside the popup. Empty Enter confirms; Ctrl-C cancels.
- The navigator accepts only `cd [directory]`, `cd ..`, `cd -`, and `z <terms>`. It loads the user's trusted zsh startup/completion code, but typed non-navigation commands, chains, pipes, redirects, backgrounding, and command/process substitution are never executed.
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
shift+↑↓ reorder   ←→ fold project   ctrl+s switch views   @ mention   alt+1–9 open
esc back/clear     ctrl+r rename     ctrl+j newline        ctrl+g cwd  ctrl+t pin to top   ctrl+x stop   ? close
```

- `Shift+Up/Down` reorders the selected row within its project and persists the order.
- `Left`/`Right` collapse and expand a focused project heading; `Enter` there toggles it. On a thread row `Right` opens the thread and `Left` does nothing.
- `Ctrl+S` switches between Fleet and Diagnostics without changing provider state.
- `@` inserts a passive thread reference. Mentioning never wakes another agent.
- `Alt+1` through `Alt+9` opens the corresponding visible thread.
- `Ctrl+R` renames the selected thread inline and persists the title.
- `Ctrl+T` toggles pinning at the top of the project group.
- `Ctrl+X` is contextual but stop-first. Help says `stop` until the selected thread has received an explicit stop step, including when it is already `Done`; only then may it say `delete` when the full tree is terminal. The visible confirmation must repeat the exact destructive action and descendant count.
- `Esc` backs out of help, an edit, a reply, a picker, or a nonempty draft and never exits Fleet. Two consecutive `Ctrl+C` presses within five seconds exit without stopping agents; the first press shows the only red inline exit confirmation near the footer, and any other key cancels it.
- At narrow widths, wrap the panel into two columns or one column. Never truncate key names or cover thread rows.

### Destructive and Failure Feedback

Stopping and deleting are separate controls. The first `Ctrl+X` always sends the stop action, even when the selected thread is already `Done`. On a live worker it changes the row to `Stopping`; on an orchestrator it drains the owned tree and reports literal progress such as `Stopping orchestrator + 3 workers · 2/4 stopped`. Repeated presses retry unfinished stops without requiring row hunting. After that explicit stop step and once the full tree is terminal, the next `Ctrl+X` asks to delete the exact thread or orchestrator plus child-thread count, and one more press within the confirmation window deletes history leaf-first. The confirmation is red; stop progress remains amber.

Failure copy keeps the thread visible, preserves its last assistant preview, and places the exact recoverable next action near the composer. Never translate broker unavailability into an empty Fleet.

## Do's Don'ts

### Do:

- **Do** reserve the `8ch` by `3-row` upper-left bay for the 8-bit octopus mark and render it only in Octo Violet.
- **Do** keep task, friendly model and effort, truthful state, assistant preview, and age visually adjacent.
- **Do** show `Done` when an active provider has completed its turn and awaits an ordinary next prompt.
- **Do** reserve `Needs input` for a concrete blocking intervention and preserve its literal text in reduced-color terminals.
- **Do** rehydrate project groups and threads from durable state after broker restart, marking unverifiable runtime ownership as `Interrupted`.
- **Do** derive previews from the beginning of the latest assistant message.
- **Do** make model selection explicit, visible, and provider-neutral through `/model`, then effort, with no confirmation step.
- **Do** preserve complete keyboard paths for every action and keep standard terminal and tmux behavior intact.
- **Do** preserve the same single-line row structure when Fleet is multiplexed.

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
