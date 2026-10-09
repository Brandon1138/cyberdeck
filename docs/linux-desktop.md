# Linux and WSL2 desktop integration

These helpers add clipboard image capture and desktop opening. They do not start a broker,
activate Remote Control, change pairing ownership, or migrate existing sessions. This document
describes desktop integration only; package installation and other Linux runtime support have
separate gates.

## Clipboard images

Use the existing **Ctrl+V** gesture in the Fleet composer to attach a clipboard image. Image
capture needs an explicit key gesture because pasting an image in a terminal may send no bytes.
The resulting absolute Linux/macOS file path stays visible in the draft. Codex and Claude keep
their existing image attachment support. Cursor and Antigravity do not gain image prompts.

- **macOS:** the existing `osascript` reader coerces clipboard images to PNG, including TIFF-only
  screenshots. Desktop previews still use `open -a Preview`.
- **Native Wayland:** install `wl-clipboard` (`wl-paste`) and run Cyberdeck inside the graphical
  session with `WAYLAND_DISPLAY` set. The reader checks advertised MIME types and reads
  `image/png`. Other image formats are not converted.
- **Native X11:** install `xclip` and run inside the graphical session with `DISPLAY` set.
  Cyberdeck queries the `clipboard` selection's `TARGETS`, then reads `image/png` when offered.
  Wayland takes precedence when both display variables exist. A failed Wayland read remains
  visible rather than silently switching clipboard sources.
- **WSL2:** Windows interop must expose Windows PowerShell as `powershell.exe` on the WSL PATH.
  Capture reads the **Windows** image clipboard through a fixed, noninteractive PowerShell STA
  bridge using .NET Windows Forms. The bridge encodes the image as PNG and sends binary bytes
  through stdout; Cyberdeck writes those bytes in private Linux storage. It creates no temporary
  Windows image file. WSLg image clipboard synchronization is not assumed, even when WSLg
  provides `DISPLAY` or `WAYLAND_DISPLAY`. Disabled interop, a missing PowerShell executable,
  unavailable Windows Forms, or blocked clipboard access produces a visible integration failure.

WSL detection uses `WSL_INTEROP`, `WSL_DISTRO_NAME`, or a Microsoft/WSL kernel release. Reader
execution still verifies capability: detection alone is not proof that Windows interop works.
Remote/headless Linux without a desktop clipboard reports unavailable integration.

A successful type query without PNG, an explicit empty-selection response, or the Windows
bridge's no-image result stays quiet. A missing reader, denied display, timeout, bad response,
or invalid image reports **unavailable**, not “no image.” Command output, clipboard text, and
PowerShell source containing user input are never included in failure messages.

Each capture shares a five-second subprocess budget, including native MIME discovery. The
Windows bridge also has a native four-second watchdog around clipboard access and encoding;
this bounds a stuck Windows call if terminating the Linux interop relay does not stop Windows
PowerShell. Cold Windows startup or compilation can exhaust the Linux deadline and reports a
timeout. PNG output is capped at **20 MiB** and checked for the PNG signature before attachment.
Type discovery is capped at 64 KiB and stderr at 4 KiB.

Images use the existing `pasted-images` subdirectory of Cyberdeck's state directory. That
directory is private (0700); files are private (0600), reserved without overwriting existing
attachments, and checked as regular files without following symbolic links. Failed/partial
captures are removed. Normal use retains the newest 20 captures. Housekeeping examines at most
256 directory entries and deletes at most 20 old capture files per paste, leaving unrelated
files, links, and directories alone. A large historical backlog is cleaned incrementally.

## Desktop opening

`scripts/desktop-open.mjs` opens HTTP/HTTPS URLs or files with the host desktop:

- macOS uses `open`; QR preview keeps the Preview application.
- Native Linux uses `xdg-open` inside a Wayland/X11 session. Install `xdg-utils` and configure
  appropriate desktop associations. Headless sessions report unavailable integration.
- WSL uses Windows associations through a fixed PowerShell bridge. Files first pass through
  `wslpath -w` as a separate argument; URLs need no path conversion. Windows paths and URLs
  travel as ASCII JSON on stdin, preserving Unicode and treating quotes, spaces, ampersands,
  and other punctuation as data. The helper does not invoke `cmd.exe` or interpolate shell code.

Commands have five-second deadlines and bounded output. Conversion failures, missing tools,
nonzero exits, and timeouts remain visible. A successful return means the desktop opener
accepted the request; it does not prove that a viewer or browser displayed it.

## Codex Remote Control helper

The RC helper keeps existing command routing, dedicated home, pairing, and activation behavior.
Only native executable discovery and QR desktop preview are extended. On macOS the default
native executable remains `~/.local/bin/codex`. Linux prefers that executable when present,
then searches absolute PATH entries for `codex`, supporting npm and system installations.
It skips its own launcher. An explicit `CYBERDECK_NATIVE_CODEX` may name an absolute native
executable; invalid overrides fail clearly. Do not point it at an RC wrapper.

When installing or copying `codex-remote.mjs` manually, keep its companion
`desktop-open.mjs` alongside it. Neither importing these helpers nor resolving the native path
starts RC or creates pairing state. Existing RC commands remain operator-controlled; this patch
does not establish live Linux/WSL RC or phone-delivery proof.

Terminal keys remain unchanged: **Ctrl+]** attaches/detaches; **Ctrl+[** cannot be bound because
it is the same byte as Escape. No Kitty keyboard protocol is forced on providers.

## Validation limits

Focused tests cover platform selection, reader failures, real subprocess timeouts and byte
limits, PNG rejection, private storage, collision preservation, bounded cleanup, Unicode/path
transport, desktop failures, native Codex discovery, and unchanged RC routing. These tests use
isolated process fixtures and injected platform readers/openers. Live Wayland, X11, Windows STA
clipboard, desktop association, and WSL2 interop need validation on their respective hosts.
