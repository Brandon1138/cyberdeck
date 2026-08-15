# Cotopus, redrawn: research and design directions

**Status:** research + design spec. No production code was written. Nothing here has been built,
run, or tested.

**Worktree:** `worktrees/cotopus-ghost-opus`, branch `agent/explore-cotopus-ghost-opus`, branched
from `2fcccf1709ec7a02ff5d1235b5087bfb59fe1efe` (`chore(release): 0.1.0-alpha.2`). This file is the
only write made to the authoritative checkout.

**Brief premise corrected up front:** the mission named a *Go* animated-ghost implementation in
Ghostty. Upstream Ghostty's ghost animation is **Zig**, with a **C** packer and a **TypeScript/React**
web original. The Go implementation that shows up in search results is a third-party
reimplementation, not upstream, and it ships derived Ghostty art. Details and evidence in
[§3](#3-what-ghostty-actually-does-primary-sources).

---

## 1. What Cyberdeck has today

### 1.1 The art and the renderer

`src/client/octopus.ts` (151 lines) holds two grids of palette indices and one renderer.

| | grid (pixels) | terminal cells | site |
|---|---|---|---|
| `OCTOPUS_SPLASH` | 32 × 27 | 32 × 14 | empty-fleet view |
| `OCTOPUS_MARK` | 12 × 8 | 12 × 4 | header, every frame |

- `src/client/octopus.ts:44-72` — `OCTOPUS_SPLASH`, 27 rows of 32 chars. Odd row count, so the last
  terminal row carries a top pixel and nothing under it.
- `src/client/octopus.ts:82-91` — `OCTOPUS_MARK`, 8 rows of 12, hand-drawn rather than downsampled.
- `src/client/octopus.ts:110-121` — `renderPixelArt(art, color)`: pairs rows `n` and `n+1` into one
  text row using `▀`, upper pixel as foreground, lower as background.
- `src/client/octopus.ts:130-143` — `renderCell`. Every coloured cell re-emits `ESC[0m` plus both of
  its own attributes; ground emits `ESC[0m` and a space and never a background.
- `src/client/octopus.ts:21-30` — the four-entry `PALETTE`, 24-bit RGB, sampled from the reference
  artwork.

### 1.2 The two integration points

- `src/client/fleet.ts:2115-2132` — `renderEmptyFleet`. Splash centred over a one-line caption. If
  `viewportHeight < height + 2` or `options.width < 32`, the art is dropped **whole** and only the
  caption survives. There is deliberately no cropped version.
- `src/client/fleet.ts:2134-2182` — `renderHeader`. The mark is shown only when `options.width >= 64`,
  laid beside three lines of text, and the header is as tall as the animal (4 rows) rather than as
  tall as the copy (3).
- `src/client/fleet.ts:1168-1194` — `renderFleet` returns one `string` for the whole screen.
- `src/client/fleet.ts:527-593` — `ANSI`. All 24-bit foregrounds. The comment at 545-546 records that
  the retired `brand` token's reservation now lives in `octopus.ts`: no state may borrow the octopus
  hues.

### 1.3 Render cadence — the constraint that shapes everything

The Fleet loop, `src/client/fleet.ts:3238-3272`:

```
while (running) {
  snapshot = await collectFleetSnapshot(client);   // 3240  ← an RPC, every iteration
  ...
  const rendered = renderFleet(snapshot, state, renderOptions);        // 3267
  output.write(`[2J[H${rendered}[r;cH[?25h`);  // 3269
  await waitForRefresh(...);                                           // 3271
}
```

`waitForRefresh` (`src/client/fleet.ts:3295-3307`) resolves on a `wake()` callback **or** after a
500 ms timeout. So:

- **Confirmed.** The whole screen is cleared with `ESC[2J` and rewritten on every paint. There is no
  region repaint and no cell diffing.
- **Confirmed.** Fleet already repaints at least twice a second at idle, and the header mark
  (1,514 bytes coloured — see §1.5) is part of every one of those paints.
- **Confirmed and decisive.** The paint interval and the *snapshot RPC* are the same loop iteration.
  Lowering the `waitForRefresh` timeout to get an animation tick would issue `collectFleetSnapshot`
  at the animation frame rate. **Any animation must decouple the frame tick from the snapshot poll.**
- **Confirmed.** Fleet runs on the alternate screen (`ESC[?1049h`, `src/client/fleet.ts:512`) with the
  cursor hidden on entry and re-shown per paint.
- **Confirmed.** There is no animation anywhere in Cyberdeck today. The only `spinner` hits in `src/`
  are regexes in `src/runtime/conversation-preview.ts:305-307` that *strip* provider spinner output.

### 1.4 Colour and theme handling

- **Confirmed.** `color` is `output.isTTY === true` and nothing else (`src/client/fleet.ts:3257`,
  `2871`, and `renderFleet`'s default of `true` at `1176`).
- **Confirmed.** There is no `NO_COLOR`, no `FORCE_COLOR`, no `COLORTERM`, no `COLORFGBG`, and no
  light/dark detection anywhere in `src/`. The only hits for those names are in
  `src/providers/launch-environment.ts:57-64`, which passes them *through* to spawned providers.
- **Confirmed.** Every colour in the interface is emitted as 24-bit `38;2;r;g;b`. No indexed colour,
  no default-foreground (`SGR 39`) reset-to-theme anywhere.

### 1.5 Measured cost of the current art

Computed by transcribing `renderCell` (`src/client/octopus.ts:130-151`) exactly and running it over
the two grids. Bytes include the trailing `ESC[0m` per row and one newline per row.

| surface | coloured | uncoloured |
|---|---|---|
| `OCTOPUS_SPLASH` (32 × 14) | **12,376 B / paint** | 1,094 B |
| `OCTOPUS_MARK` (12 × 4) | **1,514 B / paint** | 128 B |

The mark alone is ~3 KB/s of terminal writes at the idle 2 Hz repaint. That is the existing baseline
and the honest anchor for any animation budget.

### 1.6 Why it is rough in light mode — measured, not asserted

WCAG relative contrast of each palette entry against a white background and against a common dark
terminal background (`#1e1e2e`):

| key | role | vs `#ffffff` | vs `#1e1e2e` |
|---|---|---|---|
| `1` `rgb(35,9,69)` | outline / deep shadow | **17.55 : 1** | **1.07 : 1** |
| `2` `rgb(108,52,140)` | body mid tone | 8.37 : 1 | 1.96 : 1 |
| `3` `rgb(158,84,196)` | lit tentacle, dome body | 4.65 : 1 | 3.53 : 1 |
| `4` `rgb(196,130,232)` | dome highlight | **2.73 : 1** | 6.02 : 1 |

The palette is a ramp **anchored on a dark background**, and that produces a figure/ground inversion
when the background flips:

- On dark, `1` at 1.07 : 1 is functionally invisible — it *is* the background. That is what makes the
  one-pixel outlines read as separation between tentacles rather than as a drawn line.
- On white, `1` becomes the loudest ink in the piece at 17.55 : 1, so the outlines stop being negative
  space and become a heavy black cage around every arm.
- Simultaneously, `4` — the highlight the dome's whole form depends on — falls to 2.73 : 1, below the
  3 : 1 floor for non-text graphics. The modelling vanishes at the same moment the outline shouts.

Adjacent-tone separation is also thin everywhere: `3`↔`4` is 1.71 : 1 and `2`↔`3` is 1.80 : 1, so the
four-step ramp is really doing about two steps of work on either background.

**Diagnosis:** the light-mode problem is not "the purples are too pale." It is that an absolute-RGB
tonal ramp encodes *which background it was drawn for*, and there is exactly one background it is
right for. Fixing it by adding a second hand-tuned light palette requires knowing which background is
in play — which Cyberdeck cannot currently learn (§4.3).

### 1.7 Documentation drift worth knowing

`DESIGN.md:116` and `DESIGN.md:186` still describe the mark as rendered in a single hue, **Octo
Violet `#B69EFF`**, "and nothing else," in an `8ch × 3-row` bay (`DESIGN.md:310`). The code has since
moved to a four-entry sampled palette and a `12 × 4` bay. Whatever direction is chosen, `DESIGN.md`
needs the same edit.

---

## 2. Tests that exist today

`tests/client/octopus.test.ts` (68 lines) is a good template and any new representation should keep
its shape:

- grids stay rectangular (`:17-22`);
- two pixel rows per terminal row, including the splash's odd-height special case (`:24-29`);
- **every rendered row is exactly `pixelArtWidth` cells wide, coloured or not** (`:31-42`) — the test
  that keeps header text aligned and stops the splash soft-wrapping into a line the viewport never
  counted;
- ground emits no background at all (`:44-48`);
- every coloured row ends in `ESC[0m` (`:50-54`);
- shape survives with half-blocks alone when colour is off (`:56-60`);
- exact dimensions are pinned (`:62-67`).

`tests/client/fleet.test.ts:1158-1191` pins the integration: the splash appears whole or not at all,
and the mark stands beside the header text and disappears below 64 columns.

---

## 3. What Ghostty actually does (primary sources)

All paths verified against `ghostty-org/ghostty` (`main`, Zig, MIT) and `ghostty-org/website`
(TypeScript, MIT) via the GitHub contents API on 2026-08-14.

### 3.1 Provenance

Everything landed in one commit: **`9cb297202ba7ee85534ed33f6cfc5681996aa5b0`**, 2025-01-09,
PR **#4876** *"cli: add +boo command"*, authored by `rockorager` (also libvaxis's author), 247 files
changed. The commit message states the mechanism and that *"the overall addition to the binary size
is 348k."*

| file | role |
|---|---|
| `src/cli/boo.zig` (240 lines) | the `ghostty +boo` action: widget, frame parser, tick loop |
| `src/build/GhosttyFrameData.zig` (75 lines) | build step that compresses frames and exposes a `framedata` module |
| `src/build/framegen/main.c` (168 lines) | the packer: concatenate + raw DEFLATE |
| `src/build/framegen/frames/frame_001.txt` … `frame_235.txt` | **235** frames, ~6 KB each |
| `ghostty-org/website` `terminals/home/animation_frames/frame_NNN.txt` | the same 235 frames, web original |
| `ghostty-org/website` `src/components/animated-terminal/index.tsx` (143 lines) | web player |
| `ghostty-org/website` `src/app/HomeContent.tsx` | passes `frameLengthMs={31}` |

Subsequent commits to `boo.zig` are maintenance only: `1739418f` (generic action parser, 2025-07-08),
`cb295b84` / `797c54a2` (Zig 0.15 / libvaxis bumps, 2025-10), `dbfc3eb6` (unused imports, 2025-11-27),
`e8525c0f` (Zig 0.16.0, 2026-05-07).

**The language claim, corrected.** Upstream is Zig (`boo.zig`) over libvaxis's `vxfw`, with a C
packer, from a TypeScript/React web original. `ashish0kumar/gostty` (Go, MIT, repo created
2025-05-26 — four months *after* upstream `+boo`) is a third-party reimplementation that ships an
`animation-data.json` of the same Ghostty art. It is not upstream and is not a provenance-clean
source for anything.

### 3.2 Frame representation

Verified against `frame_001.txt` (5,974 bytes):

- **Exactly 41 content lines**, each **exactly 100 visible columns** after stripping markup, plus a
  trailing newline (so a naive line split yields 42 pieces, the last empty).
- Glyph inventory of that frame, sparse → dense:
  `' '`, `·` (U+00B7), `~`, `o`, `x`, `+`, `=`, `*`, `%`, `$`, `@` — an **11-level density ramp**, one
  non-ASCII character.
- The only markup is `<span class="b">` … `</span>`. It is a **one-bit style channel** overlaid on the
  ramp, nothing more — no colour value is carried in the frame at all.
- Body cells (outside spans) are drawn in the ramp; span cells are the outer aura/outline.

`boo.zig:109-172` (`updateFrame`) parses this with a four-state machine — `normal`, `span`, `in_tag`,
`in_closing_tag` — walking codepoints, swapping style on tag boundaries, skipping tag bytes, and
ending with `std.debug.assert(cell_idx == self.buffer.len)` — i.e. **every frame must fill exactly
100 × 41 = 4,100 cells or the program traps.** That assertion is the load-bearing invariant and is
worth stealing outright as a test.

### 3.3 The theme behaviour, which is the whole point

`boo.zig:207-208`:

```zig
boo.ghostty_style = .{};                        // default style: no fg set at all
boo.outline_style = .{ .fg = .{ .index = 4 } }; // ANSI palette index 4
```

- The ghost's body uses **the terminal's own default foreground**. Not white, not a hex value.
- The aura uses **palette index 4** — the theme's own blue, whatever the operator's colour scheme
  says that is.
- **There is no 24-bit colour anywhere in the animation.**

That is why it is correct on every theme without detecting anything. Two properties combine:

1. **A density ramp is background-invariant.** More glyph coverage means more ink. On a dark
   background more ink means brighter; on a light background more ink means darker. Either way "more
   ramp = more form." The mapping needs no knowledge of which background is present, which is exactly
   the property Cyberdeck's absolute-RGB ramp lacks (§1.6).
2. **Default foreground and indexed accents are resolved by the terminal**, which already knows the
   operator's theme.

### 3.4 Timing, rendering, sizing, fallbacks

- **30 fps.** `boo.framerate = 1000 / 30` → 33 ms (`boo.zig:206`), re-armed each tick with
  `ctx.tick(self.framerate, self.widget())` (`boo.zig:56`). Web uses `frameLengthMs={31}`
  (`HomeContent.tsx:76`).
- **Loop:** `self.frame += 1; if (self.frame == frames.len) self.frame = 0;` (`boo.zig:170-171`) —
  235 frames at 30 fps ≈ **7.8 s**.
- **Rendering is not Ghostty's own.** `boo.zig` builds a `[100*41]vaxis.Cell` buffer and hands it to
  libvaxis's `vxfw.App` (`boo.zig:201-211`), which owns alt-screen entry, the tick scheduler, and the
  screen update. There is no manual clear-and-redraw and no `ESC[2J` in `boo.zig` at all. **This is
  the single biggest architectural difference from Fleet**, which clears and rewrites the whole screen
  every paint (§1.3).
- **Unicode/width:** each codepoint is stored as `.char = .{ .grapheme = char, .width = 1 }`
  (`boo.zig:157-162`) — width is asserted, not measured. Safe only because the art is deliberately
  restricted to width-1 characters.
- **Undersize fallback:** below 100 × 41 the widget draws the literal string
  `"Screen must be at least 100w x 41h"` centred (`boo.zig:75-79`). No scaling, no cropping — the same
  all-or-nothing stance `renderEmptyFleet` already takes.
- **Reduced motion:** the **web** player honours it — `window.matchMedia("(prefers-reduced-motion:
  reduce)").matches` returns early and the animation never starts, leaving frame 16 as a still
  (`animated-terminal.tsx:82`, `:90-95`). The web player also pauses on window blur and resumes on
  focus (`:97-98`, `:117-123`). **The CLI has neither.** `+boo` animates unconditionally until
  Ctrl+C or Esc (`boo.zig:58-65`). If Cyberdeck wants a reduced-motion path it is inventing one, not
  porting one.
- **Storage:** frames are concatenated with `\x01` and raw-DEFLATE'd (`framegen/main.c:9`, `:119-138`),
  `@embedFile`'d through a generated Zig source (`GhosttyFrameData.zig:17-22`), and decompressed at
  startup into a slice of frame views (`boo.zig:223-240`). This is a solution to *1.4 MB of frames*.
  At the frame counts proposed below it is unnecessary complexity and should not be copied.

### 3.5 Hypothesis (not verified): the frames are machine-generated

235 frames at 100 × 41 with a smooth 11-level ramp and span markup confined to the outer aura is not
plausibly hand-authored. Most likely a rendered animation was converted to ASCII by luminance
bucketing, with the aura tagged by a second pass.

**Falsifier:** find a generator in `ghostty-org/website` history, or an issue/PR describing hand
authoring. I did not find one; I also did not exhaustively search web history, so this stays a
hypothesis. **It matters for us:** if Cotopus goes the ramp route, Cyberdeck needs an authoring
pipeline, and "hand-draw 24 frames of 50 × 18" is a real cost that should be priced before the
direction is chosen.

### 3.6 Licensing and provenance

- `ghostty-org/ghostty` — **MIT**. `ghostty-org/website` — **MIT**. That covers the code *and*, on its
  face, the frame `.txt` files.
- **MIT is not a trademark licence.** The ghost is Ghostty's identity mark. No dedicated brand policy
  page surfaced for Ghostty, but the distinction is standard and Cyberdeck already asserts the same
  thing about its own marks in `TRADEMARKS.md`: *"It does not grant permission to use the Cyberdeck
  name, logos, or other project branding to imply endorsement or official status."* Reproducing
  Ghostty's ghost — or a recoloured octopus-ish derivative of those exact frames — would be brand
  confusion regardless of the licence text.
- **Therefore: take the technique, never the art.** The density-ramp representation, the one-bit style
  channel, the fixed-size cell-count assertion, and default-fg + indexed-accent styling are ideas and
  mechanisms, not expression. Not one byte of `frame_NNN.txt` should be copied, adapted, or
  "octopus-ified."
- **Do not use `gostty` or any other reimplementation as a source.** Their MIT licence covers their
  wrapper code; the `animation-data.json` inside is derived Ghostty art with a laundered-looking
  provenance chain.
- Cyberdeck is **Apache-2.0** (`LICENSE`, `NOTICE`). New Cotopus art must be original work. Record its
  provenance in a module header the way `octopus.ts:14-20` records the current palette's.
- Nothing in this document requires a `NOTICE` entry, because nothing is being copied. If any of it
  changes, that changes.

---

## 4. Design directions

Three cross-cutting decisions first, because they cut across every direction.

### 4.1 Representation: pixel grid vs density ramp

| | half-block pixel grid (today) | density ramp (Ghostty) |
|---|---|---|
| vertical resolution | 2 pixels per row | 1 cell per row |
| tone | absolute RGB, background-dependent | glyph coverage, background-invariant |
| bytes / cell (coloured) | up to ~45 | ~1–2, plus one SGR per accent run |
| no-colour fallback | half-block silhouette, tone lost | **unchanged** — the ramp *is* the tone |
| light-mode behaviour | inverts (§1.6) | correct by construction |
| authoring | pixel editing | luminance bucketing from a render |

The ramp costs half the vertical resolution and buys theme-correctness, a ~10× byte reduction, and a
no-colour mode that loses nothing. That trade is why the recommendation below is Direction B.

### 4.2 Reduced motion

Ghostty's CLI has no reduced-motion path, so there is nothing to port. Whatever Cyberdeck does it is
inventing. Options, cheapest first:

1. **Respect the environment.** Honour `NO_COLOR` for colour and add a `CYBERDECK_REDUCED_MOTION`
   (and/or the emerging `NO_MOTION`) env check that pins the frame index to 0. One `if`, testable,
   no UI surface.
2. **A `/motion on|off` slash command**, in the shape of the existing `/nvim-settings`
   (`src/client/fleet.ts:343-349` lists the current command names). Discoverable, persistable.
3. **Both**, env as the default and the command as the override.

Independent of choice: **animation must not run when `output.isTTY !== true`** — the same gate that
already governs colour.

### 4.3 Light/dark: how would Cyberdeck even know?

| approach | verdict |
|---|---|
| **Don't need to know** — density ramp + default fg + one accent | **Recommended.** Zero detection. This is Ghostty's answer and it is why theirs works everywhere. |
| **OSC 11 background query** | **Blocked today, and dangerous.** See below. |
| `COLORFGBG` env | Set by some terminals, absent in others. Unreliable enough that relying on it means shipping two code paths and testing one. |
| Explicit `/theme light\|dark\|auto` | Deterministic and cheap. Reasonable *as an accent-hue override*, poor as the only defence — it makes the operator responsible for the art looking right. |

**The OSC 11 hazard — confirmed by reading the decoder.** `FleetKeyDecoder.decode`
(`src/client/fleet.ts:3357-3443`) recognises CSI (`ESC [`, `:3383-3393`) and SS3 (`ESC O`,
`:3395-3402`). It has **no OSC branch.** A terminal's reply to an OSC 11 query is
`ESC ] 11 ; rgb:1e1e/1e1e/2e2e ESC \`. That falls through to the Meta-chord branch at `:3409-3418`,
which consumes `ESC ]` as a chord and then hands every following byte to `:3441`
(`code >= 0x20` → push the character) — i.e. **`11;rgb:1e1e/1e1e/2e2e` would be typed into the
operator's composer draft.** Background detection is not a small addition; it requires decoder work
first, and `BUGS.md`'s standing constraints section is the thing to read before touching that file.

---

### Direction A — "Ink Drift": animate the existing pixel grid

Keep `renderPixelArt` and the palette. Add a frame axis.

- **Representation:** `OCTOPUS_SPLASH_FRAMES: readonly (readonly string[])[]`, each frame the same
  grid shape as today.
- **Dimensions:** 32 × 28 pixels → **32 × 14 cells**. Going to an even pixel height removes the odd-row
  special case that `tests/client/octopus.test.ts:24-29` currently pins.
- **Motion:** the mantle bobs ±1 pixel row; arm tips curl inward and release. **8 stored frames,
  ping-ponged** to 14 steps.
- **Timing:** 8 fps (125 ms). Loop period 1.75 s.
- **Light/dark:** *unsolved without detection.* Requires a second hand-tuned `PALETTE_LIGHT` plus one
  of §4.3's detection routes. This is the direction's fatal cost.
- **No colour:** works — the existing half-block fallback carries the silhouette, and a moving
  silhouette still reads as motion.
- **Budget:** 12,376 B/frame × 8 fps ≈ **99 KB/s** while the empty-fleet view is on screen.
- **Verdict:** the least disruptive to existing code and the only one that keeps the current artwork.
  It does not fix light mode, and it is the most expensive per frame by an order of magnitude.

### Direction B — "Ghostty method": a density-ramp Cotopus  ★ recommended

Adopt Ghostty's representation wholesale — the *representation*, not the art.

- **Representation:** one plain-text frame per entry, fixed `W × H` **character cells**, each cell a
  glyph from a declared ramp, plus a one-bit accent channel. Ghostty's channel is HTML spans because
  the frames are shared with a web page; Cyberdeck has no such constraint, so a cleaner channel is a
  parallel mask (a second grid of `.`/`#`) or an uppercase/lowercase convention. **Do not import HTML
  parsing into a TUI for no reason.**
- **Ramp (proposed, 11 levels, sparse → dense):** `' ' · ~ o x + = * % $ @` — identical in *structure*
  to Ghostty's because that is a well-known luminance ramp, not their invention. Only `·` (U+00B7) is
  non-ASCII; every glyph is width 1 and BMP.
- **Dimensions:** **50 × 18 cells** for the splash. Rationale: 18 rows is close to the current splash's
  14, the empty-fleet guard needs `viewportHeight >= H + 2` = 20 rows, and 50 columns fits the
  `Math.max(50, …)` width floor at `src/client/fleet.ts:1173`. **The header mark cannot use this
  representation** — 4 rows is not enough vertical resolution for a ramp — so the mark stays
  half-block (see Direction C for the mark).
- **Timing:** **12 fps (83 ms), 24 frames, 2 s loop.** Not Ghostty's 30 fps: Fleet clears the screen
  every paint (§1.3), and 30 Hz of `ESC[2J` is a flicker source rather than a smoothness gain. 12 fps
  is enough for a slow drift and is a factor of 6 below the poll RPC problem.
- **Light/dark:** **correct with no detection.** Body cells emit no colour (terminal default
  foreground); accent cells get one Cotopus hue. On a light theme the ramp reads dark-on-light; on a
  dark theme, light-on-dark; the modelling survives both because it is coverage, not luminance.
- **No colour:** the accent is simply not emitted. **Nothing else changes** — the ramp already carried
  all the form. This is strictly better than today, where `color: false` throws away all four tones.
- **Budget:** ~50 × 18 = 900 cells; body glyphs are 1–2 bytes each, accent runs cost one SGR pair per
  run. Estimate **1.5–2.5 KB/frame**, so 12 fps ≈ **18–30 KB/s** — and a *single* frame is cheaper than
  the current **static** splash's 12,376 B.
- **Source size:** 24 frames × ~950 chars ≈ **23 KB** of TypeScript source. Ghostty compresses because
  235 frames × 6 KB is 1.4 MB; at 23 KB, **do not build a compression pipeline.** Cyberdeck has no
  asset build step and should not grow one for this.
- **Cost, stated honestly:** this needs new art, and per §3.5 the ramp style probably wants a
  render-and-bucket pipeline rather than hand-drawing. That authoring effort is the real price of this
  direction.

**Indicative frame sketch — 50 × 18, structure only, NOT final art:**

```
                    +===***%%%%%%%%***===+
              +=*%$@@@@@@@@@@@@@@@@@@@@$%*=+
           =*$@@@$$$$$$$$$$$$$$$$$$$$$$@@@$*=
          *$@@$$$$$$$$$$$$$$$$$$$$$$$$$$$$@@$*
        x@@$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$@@x
       ~@$$$$$@@@@@@$$$$$$$$$$$$$@@@@@@$$$$$$@~
       o@$$$$@@%%%%@@$$$$$$$$$$$@@%%%%@@$$$$$@o
       o@$$$$@@%%%%@@$$$$$$$$$$$@@%%%%@@$$$$$@o
       ~@$$$$$@@@@@@$$$$$$$$$$$$$@@@@@@$$$$$$@~
        x@$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$@x
        +@$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$@+
        =$@$$$$@@@@@$$$$$@@@@@$$$$$@@@@@$$$@$=
       ~*$@@$$@%   %@$$$@%   %@$$$@%   %@$@@$*~
      o*$@$@@$@     $@$@$     $@$@$     @$@@$*o
    x*$@$  $@x     x@$@x     x@$@x     x@$  $*x
  +*$@x   ~@o      o@o       o@o      o@~   x@$*+
~*$@o     x~       ~         ~        ~x     o@$*~
o=*x      ·                                  x*=o
```

Read: `@ $ %` fill the mantle and arms (default foreground); `+ = * x o ~ ·` at the silhouette edge are
the accent channel (one Cotopus hue). Two eyes at rows 7-8. **This sketch shows six arms, not eight,
and the arms are too symmetric** — it exists to make the representation and scale concrete, and to be
argued with. It is not a proposal for the final animal.

**Motion proposal for 24 frames:** the mantle rises and falls ~1 row over the cycle; each arm has its
own phase offset so the fringe ripples rather than pulsing in unison; the accent edge breathes one
ramp step in and out with the mantle. Slow, ambient, never a "loading" signal — this sits under
*"No durable agent threads yet"*, so it should read as idle, not as work.

### Direction C — "Living mark": animate the header, not the splash

- **Surface:** the 12 × 4 header mark only. Splash stays as-is (or gets Direction B independently).
- **Representation:** unchanged half-block grid, plus 3–4 alternate poses.
- **Timing:** two flavours —
  - **C1, timed:** 1–2 fps. Slow enough that the existing 500 ms poll is *already* a sufficient tick,
    so **no cadence change is needed at all.**
  - **C2, state-driven:** no timer whatsoever. The pose is a pure function of fleet state — arms at
    rest when nothing is running, one arm raised when a thread needs input, a "reaching" pose while
    work is live. Zero new frames per second; every repaint is one Fleet was doing anyway.
- **Light/dark:** does not fix it. The mark inherits the same palette problem (§1.6).
- **Budget:** C1 at 2 fps is exactly today's cost (1,514 B × 2 Hz ≈ 3 KB/s). **C2 is free.**
- **Verdict:** by far the cheapest and the most *Cyberdeck* — it makes the mark mean something rather
  than merely move. C2 also sidesteps reduced-motion entirely: state changes are not decorative
  motion. Weakest on the "replace the rough mascot" goal, since it changes behaviour, not artwork.

### Direction D — "Bioluminescent pulse": animate colour, hold the shape

A static silhouette with a highlight travelling down the arms, cycling the palette per cell.

Recorded so it is not rediscovered as a fresh idea: it is the **worst** option here. It encodes the
entire animation in colour, so `color: false` gets a still image and light mode gets a wash; it is the
most expensive per frame (every cell re-emits full SGR every frame); and it fixes nothing about §1.6.
**Not recommended.**

---

## 5. Integration architecture (applies to A, B, and C1)

1. **Decouple the frame tick from the snapshot poll.** `src/client/fleet.ts:3240` runs
   `collectFleetSnapshot` at the top of every loop iteration, so shortening `waitForRefresh` multiplies
   RPCs by the frame rate. Two viable shapes:
   - **(a) A render-supplied deadline.** `waitForRefresh` takes a timeout computed from state:
     500 ms normally, the animation interval only while an animated surface is visible — *and* the
     loop skips `collectFleetSnapshot` on iterations woken by the animation deadline rather than by
     `wake()` or the 500 ms poll. One loop, one write path, one new branch.
   - **(b) A separate animation timer** that calls `wake()`. Simpler to write, but every wake still
     drags a snapshot RPC with it. **Only acceptable if the snapshot is also gated.**
   Recommend (a).
2. **The frame index must be a pure function of time, not a counter.** `frameAt(now, spec)` derived
   from `Date.now()`. A counter incremented per paint would speed the animation up whenever the
   operator types or a thread reports, because those already trigger a paint. This is also what makes
   the animation trivially testable with an injected `now` — `FleetRenderOptions` already carries
   `now` (`src/client/fleet.ts:315`).
3. **Address the flicker before shipping motion.** Every paint is `ESC[2J` + full frame
   (`src/client/fleet.ts:3269`). At 12 fps on the alt screen this may tear visibly. The standard fix
   is to drop `ESC[2J` and instead emit `ESC[K` (erase to end of line) after each row, so each cell is
   overwritten rather than blanked-then-drawn. That is a general Fleet improvement worth making on its
   own merits, and it is independently testable at the byte level. **It is untested here.**
4. **Keep the all-or-nothing sizing rule.** `renderEmptyFleet` already drops the art whole rather than
   cropping (`src/client/fleet.ts:2122-2124`), and Ghostty independently arrives at the same stance
   (`boo.zig:75-79`). Do not introduce scaling or cropping.
5. **Gate on `isTTY`.** Same gate as colour. A non-TTY Fleet render (`src/client/fleet.ts:2751-2752`)
   must produce one deterministic still frame.
6. **Frames live beside the renderer** in `src/client/`, as a TypeScript module of string arrays. No
   asset pipeline, no compression, no `@embedFile` analogue (§4 Direction B, "source size").

---

## 6. Performance budget

Anchors from §1.5: the current **static** splash is 12,376 B/paint and the header mark is
1,514 B/paint at ≥2 Hz.

Proposed ceilings:

| bound | value | why |
|---|---|---|
| bytes per animated frame | ≤ 3 KB | under the current *static* splash cost |
| frame rate | ≤ 12 fps | under the `ESC[2J` flicker threshold; 6× headroom vs the RPC loop |
| sustained write rate | ≤ 36 KB/s | 3 KB × 12 fps, only while animating |
| snapshot RPCs added | **0** | the animation tick must never call `collectFleetSnapshot` |
| animation active only when | empty-fleet view visible **and** `isTTY` **and** motion enabled | |
| per-frame allocation | frames precomputed at module load | no per-frame string building |

Direction A blows the first and third bounds (99 KB/s). Direction B fits with room. Direction C1 is at
today's cost; C2 adds nothing.

---

## 7. Test plan

Extending `tests/client/octopus.test.ts`'s existing shape:

**Frame integrity**
- Every frame is rectangular, and **all frames share one `W × H`**.
- **The cell-count assertion, ported from `boo.zig:167`:** a frame that renders to anything other than
  `W × H` cells is a hard failure, not a soft misalignment. This is the single most valuable idea to
  take from upstream.
- Every glyph is a member of the declared ramp; the accent mask is the same shape as the frame and
  contains only its two symbols.

**Rendering**
- Rendered row width in *terminal columns* equals `W` for `color: true` and `color: false` — a direct
  extension of `tests/client/octopus.test.ts:31-42`, and the test that keeps the splash from
  soft-wrapping.
- `color: false` output contains **no** SGR bytes at all.
- **Direction B specifically:** body cells emit no `38;2;` sequence — assert the *absence*, which is
  what proves the body is riding the terminal's default foreground rather than a hardcoded colour.
  This is the theme-correctness test.
- Every coloured row still closes with `ESC[0m` (`tests/client/octopus.test.ts:50-54`).

**Timing**
- `frameAt(now)` is pure: the same `now` yields the same frame, and calling it repeatedly does not
  advance anything.
- The loop period is exactly `frames.length × intervalMs`; `frameAt(t)` equals `frameAt(t + period)`.
- Reduced motion (env or setting) pins the index to 0 for every `now`.
- Non-TTY renders produce the same deterministic still frame.

**Integration** (extending `tests/client/fleet.test.ts:1158-1191`)
- The splash still appears whole or not at all at the new height.
- Two renders at two injected `now` values differ; two renders at the same `now` are byte-identical.
- **The animation adds no `collectFleetSnapshot` calls** — assert against the existing fake transport.

**Visual regression**
- A golden snapshot of frame 0, uncoloured, so silhouette changes are reviewed rather than absorbed.

---

## 8. Confirmed / hypothesis / unverified

### Confirmed (read from source or computed deterministically)
- Every file/line citation in §1, §2, §3.1–§3.4.
- Fleet clears and rewrites the whole screen every paint, on the alt screen, at ≥2 Hz
  (`fleet.ts:3269`, `:512`, `:3295-3307`).
- The paint loop and the snapshot RPC are the same iteration (`fleet.ts:3240`).
- No light/dark, `NO_COLOR`, or `COLORFGBG` handling exists in `src/`.
- `FleetKeyDecoder` has no OSC branch, so an OSC 11 reply would be typed into the composer
  (`fleet.ts:3357-3443`).
- The measured byte costs in §1.5 and contrast ratios in §1.6 (arithmetic, reproducible).
- Upstream Ghostty's ghost is Zig + C + TS. Go is third-party.

### Hypotheses (with falsifiers)
- **"Ghostty's frames are machine-generated."** Falsifier: a generator or authoring note in either
  repo's history. Not found; search was not exhaustive.
- **"A density ramp is theme-invariant."** Falsifier: a light theme with a weak foreground
  (grey-on-white) — dense cells would still be low contrast. Test by rendering frame 0 as `#666` on
  `#fff` before committing to Direction B.
- **"Accent-on-default-foreground is always distinguishable."** Falsifier: an operator theme whose
  default foreground is close to the Cotopus purple.
- **"12 fps reads as motion and 30 fps would flicker."** Both are judgements about the operator's
  terminal, untested.
- **"Dropping `ESC[2J` in favour of `ESC[K` removes the tearing."** Standard technique, unverified
  here.
- **"1.5–2.5 KB per Direction-B frame."** An estimate from cell counts and expected accent-run counts,
  not a measurement — there is no frame to measure yet.

### Unverified runtime state (nothing was executed)
- **No build, no `pnpm`, no `vitest`, no Fleet run, and no `ghostty +boo` run.** The worktree was
  created and read; nothing in it was compiled or executed.
- The §1.5 byte figures come from a Python transcription of `renderCell` (`octopus.ts:130-151`), not
  from running the TypeScript. The transcription is faithful but is not the code under test.
- The §1.6 light-mode conclusion is computed against `#ffffff` and `#1e1e2e`. **No screenshot of Fleet
  on a light terminal was taken.** Real terminal backgrounds vary and the specific numbers will move;
  the figure/ground inversion will not.
- libvaxis's internal update strategy (diffing vs full redraw) was inferred from `boo.zig`'s absence
  of any clear sequence, not read from libvaxis source.
- Whether Fleet ever receives focus/blur events was not established — Fleet deliberately pops mouse
  and focus reporting on entry (`DISABLE_INHERITED_TERMINAL_INPUT_MODES`, `fleet.ts:512`), so
  Ghostty's web-style "pause when unfocused" is probably unavailable. **Not confirmed.**
- `docs/design/` did not exist before this file.

---

## 9. Recommendation

**Direction B (density-ramp Cotopus splash) + Direction C2 (state-driven header mark), with §4.2
option 1 for reduced motion and no background detection at all.**

Because:

- B is the only direction that **fixes light mode**, and it fixes it by construction rather than by
  detection — which matters given that detection is currently blocked behind decoder work (§4.3).
- B makes the **no-colour** rendering as good as the coloured one, which today it is not.
- B is **cheaper animated than the current art is static** (§6).
- C2 costs nothing, needs no tick, raises no reduced-motion question, and makes the mark carry meaning
  instead of decoration.
- The honest cost is **new artwork plus, probably, an authoring pipeline** (§3.5). That is the thing to
  weigh before committing.

The fallback if the art cost is unacceptable: **C2 alone**, plus a light-mode-safe repalette of the
existing grids. That leaves the mascot un-animated but stops it looking broken on a light terminal —
and it is a few hours, not a project.
