# Voice hold-to-talk in the Cyberdeck orchestrator: findings

Worker 9f3faf04 (voice-keys-opus), 2026-10-09. Angle: the terminal and key-event path.

## Verdict

**The key path is fine. Hold-to-talk is not enabled inside the orchestrator's Claude process at
all.** The orchestrator is launched with `--setting-sources project,local`. `/voice` persists its
switch to **user** settings (`~/.claude/settings.json`), and that scope is not loaded into the
running orchestrator. So the orchestrator never sees `voiceEnabled: true`, and its space-bar hold
handler stays disarmed. Every space you hold is typed as a literal space.

This brief assumed that hold mode needs a key-release event. It doesn't. Claude Code 2.1.280 never
asks any terminal for release events. It infers release from gaps in auto-repeat (see the detection
mechanism below). tmux `extended-keys` has nothing to do with this symptom.

## Ranked hypotheses

### 1. CONFIRMED: orchestrator setting sources exclude the scope `/voice` writes to

Evidence:

- Orchestrator argv, read from `ps` for pid 95264 (session 6208e41d):
  `--remote-control --setting-sources project,local --settings …/launch-settings.json`.
  The code that emits it is `addOrchestratorIsolation` at `src/providers/claude.ts:270-274`. It
  applies to orchestrators only, and the docblock above it says it deliberately drops user scope.
- The `/voice` implementation in the bundle (`chunk` near offset 188874576):
  ```js
  let a=Ye(), v=eEt(a), t=L(s);              // Ye() = this session's merged settings
  if(t==="off"||t===void 0&&v){ ...write userSettings {voiceEnabled:false}...; "Voice mode disabled." }
  ... await Jt("userSettings",{voiceEnabled:!0,voice:{...a.voice,enabled:!0,mode:l}}) ...
  return `Voice mode enabled (${l}). Hold space to record.`
  ```
  `eEt(e) = (e.voice?.enabled ?? e.voiceEnabled) === true`. With no argument, `/voice` is a toggle.
  In a normal session, a second `/voice` prints "Voice mode disabled." The orchestrator printed
  "enabled" on all three runs: 08:32:51, 08:33:02 and 08:40:35 UTC, all in the transcript
  `~/.claude/projects/-Users-brandon-code-personal-cyberdeck/6208e41d-….jsonl`. So its merged
  settings never contained the value it had just written.
- The write itself did land. `~/.claude/settings.json` now contains
  `{"voiceEnabled": true, "voice": {"enabled": true, "mode": "hold"}}`. That is the file a fresh
  terminal's Claude reads, which is why the fresh terminal works.
- Proof that the hold handler was disarmed, using the broker journal (`events.jsonl`,
  `session.input` rows):
  - The hold at 08:32:54.678 delivered **37** one-byte events.
  - The next prompt, at 08:33:00.557, was exactly **37 spaces followed by `/voice`**.
  - An armed handler consumes and strips every space from the 3rd one on, during warm-up and
    recording. At most 2 spaces per attempt can survive.
  - All 37 survived, so the handler returned at its first guard: `if(!F)return`, where
    `F = OH() = eEt(appState.settings) && hasVoiceAuth`.
- Workers are not affected, because only orchestrators get `--setting-sources`.

### 2. RULED OUT: the key-release / kitty / extended-keys path

- On raw-mode entry Claude writes `CSI < u` + (`CSI > 1 u` legacy | `CSI > 5 u`) + `CSI > 4 ; 2 m`.
  The bundle constants are `Pho=ra(">5u")`, `Iho=ra(">1u")`, `pTr=ra("<u")` and
  `Hho=ra(">4;2m")`. Kitty flags 5 = 1 (disambiguate) + 4 (report alternate keys). Flag 2 (report
  event types: press, repeat, release) is never requested, so no terminal sends Claude a release
  event, inside Cyberdeck or out.
- The orchestrator pane and a "fresh terminal" pane sit on the **same** tmux server, the one Ghostty
  starts per window as `tmux -L ghostty-<date>-<pid>`. Server options can't explain a difference
  between them.

### 3. RULED OUT: jitter or coalescing in the `cyberdeck attach` relay

- Path:
  Ghostty → tmux pane `%28` → `cyberdeck attach 6208e41d…` (pid 95289) → broker unix socket →
  `registry.write` → node-pty (ttys024) → `claude` (pid 95264).
  `TMUX` is unset inside the orchestrator because Claude is a child of the broker (pid 27909) on
  the broker's own PTY, not of tmux. `TERM_PROGRAM=tmux` is inherited from the broker's
  environment.
- For orchestrators, `src/client/attach.ts:243-248` forwards input bytes unparsed and without
  holding them back, because `detachOnLeftArrow` is false.
- Broker-side timestamps for each held space show clean auto-repeat. There's an initial delay of
  about 500 ms, then 72–95 ms per repeat, which is the operator's macOS repeat rate of roughly
  83 ms. Runs at 08:32:42, 08:32:47, 08:32:54, 08:33:04, 08:40:37 and 08:40:41. For example, at
  08:32:54: `502, 83, 83, 84, 83, 84, 83, …`.
- Claude's thresholds are 120 ms to engage and 200 ms for release. These trains would engage and
  sustain recording.

### 4. LATENT: broker event-loop stalls would cut a recording short once voice is enabled

- The 08:40:37 run contains a `231 ms, 1 ms` pair: two repeats delivered together after a stall.
  Any delivered gap over 200 ms ends a hold recording. The 444/506 ms gaps in the same run are
  re-presses (about 500 ms initial delay), not stalls.
- The likely cause is broker event-loop load. `SessionIoSurface.write` (`session-io-surface.ts:100`)
  does a synchronous PTY write and then awaits `appendEvent("session.input")` per keystroke, and
  the same loop serves every session and Fleet.
- This isn't the current bug, but expect an occasional early stop after fix #1. If that becomes
  real, the remedy is to stop journaling every keystroke on the hot path, for example by
  coalescing `session.input` events.

## Detection mechanism in the bundle (Claude Code 2.1.280)

The hold handler is `Xve(...).handleKeyDown`, around bundle offset 186678861. With the default
binding `space: "voice:pushToTalk"` in `Chat` context:

- Constants: `xt=120` (inter-key reset), `Ro=5` (count to engage), `yn=2` (count to show
  "keep holding…").
- While not engaged:
  - The first 2 spaces are typed.
  - Later spaces are swallowed.
  - At 5 spaces, each within 120 ms of the last, it engages: it strips the typed spaces and calls
    `voice.handleKeyEvent()`.
- While engaged: every space is swallowed and calls `handleKeyEvent()`.
- Voice controller `handleKeyEvent` (offset 201977038):
  - From idle: start recording and arm a 600 ms fallback (`j=600`). The log line is
    "[voice] No auto-repeat seen, arming release timer via fallback".
  - While recording: each call re-arms a release timer of `z=200` ms. When it fires,
    `finishRecording`.
- **Release is a 200 ms gap in auto-repeat, not a key-up event.**
- Gate: `if(!F)return`, with `F = eEt(settings) && voiceAuth`. This is where the orchestrator
  exits.
- `/voice tap` also exists and uses the same gate. Tap mode alone would not help the orchestrator.

## tmux values observed (read-only, server `-L ghostty-20261007-105433-2633`)

- Server:
  - `default-terminal tmux-256color`
  - `escape-time 0`
  - `extended-keys off`
  - `extended-keys-format xterm`
  - `focus-events on`
  - `terminal-features`: `xterm*:clipboard:ccolour:cstyle:focus:title`, `screen*:title`,
    `rxvt*:ignorefkeys`, `xterm-ghostty:RGB`, `ghostty:RGB`
  - `terminal-overrides`: `linux*:AX@`
- Client: `termtype=ghostty 1.3.1`, `termname=xterm-ghostty`,
  `features=bpaste,ccolour,clipboard,cstyle,focus,RGB,title`.
- Panes:
  - `main:1.1 %12` is the broker's zsh on ttys001.
  - `main:1.2 %28` is `cyberdeck attach 6208e41d` (the orchestrator).
  - `main:1.3 %27` is `cyberdeck attach 5cf7a5be`.
- Cyberdeck's only tmux key option is `set-option -s escape-time 10` in `src/tmux/cockpit.ts:102`.
  It applies only when Cyberdeck creates its own cockpit session. Neither `src/fleet/` nor
  `src/orchestration/` sets any key option. Nothing here affects space or auto-repeat.

## Proposed fix

**Immediate, no code.** The operator adds the voice keys to a scope the orchestrator *does* load,
the local settings of the orchestrator's cwd:
`/Users/brandon/code/personal/cyberdeck/.claude/settings.local.json`.

```json
"voiceEnabled": true,
"voice": { "enabled": true, "mode": "hold" }
```

Merge these keys into the existing JSON object, then restart or resume the orchestrator if it
doesn't pick them up live. It only covers orchestrators whose cwd is that repository. This worker
did not touch that file, because the main checkout is off-limits.

**Code fix (recommended).** Carry the operator's voice preference through the one `--settings`
file Cyberdeck already writes. In `claudeLaunchSettings` (`src/providers/claude/launch-settings.ts`):
when `input.orchestrator`, read `voiceEnabled` and `voice` from the operator's
`~/.claude/settings.json` and copy only those keys into the emitted JSON. This means adding
`voiceEnabled?: boolean; voice?: {...}` to `ClaudeLaunchSettings` and having the adapter pass
`input.userVoice`. The operator's user-scope intent then reaches the orchestrator without
re-admitting user scope, so the roughly 5.3k-token isolation stays intact.

Trade-off: flag settings outrank user scope. `/voice off` inside an orchestrator would write user
settings that the orchestrator still doesn't read, so it would keep printing "disabled" while staying
enabled until the next launch. That needs to be stated in the code comment. Re-admitting `user` in
`--setting-sources` is the alternative this repository already rejected for token cost.

## OPEN QUESTIONS

1. **The ~1 s ANC dip.** It's most likely `/voice` itself, not the hold. Every orchestrator `/voice`
   takes the enable path, which runs `checkRecordingAvailability(..., {probeForwarded:true})` and
   `requestMicrophonePermission`. Both can open the input device briefly. Confirm by running
   `/voice` in the orchestrator without touching space and watching ANC. This is inferred from the
   code, not observed.
2. Does Claude 2.1.280 pick up a `settings.local.json` change live, or does the orchestrator need a
   resume? Not tested.
3. Should the code fix mirror only `voiceEnabled`/`voice`, or the other per-user UX keys an
   orchestrator silently loses the same way (theme, keybindings, `language`)? Those are lost for
   the same root cause and are worth a sweep.
4. Hypothesis 4 (broker stalls over 200 ms) is only worth acting on if early cut-offs appear after
   the fix.
