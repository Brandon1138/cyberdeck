import { execFile } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Reading an image out of the composer's paste path is not a decoding problem, it is an
 * out-of-band one. The fleet turns bracketed paste *off* on the shared pane, and even with it on a
 * terminal writes nothing to the pty for an image-only pasteboard: Cmd+V of a screenshot delivers
 * zero bytes, so there is no payload to inspect and no keypress to hang the feature off. The only
 * signal available is an explicit chord, which is why the composer binds ctrl+v and reads the
 * pasteboard here rather than parsing anything out of stdin.
 */
export type PasteboardCaptureOutcome = "captured" | "no-image";

/** Write the pasteboard's image to `destination`, or report that it holds none. */
export type PasteboardCapture = (destination: string) => Promise<PasteboardCaptureOutcome>;

/** The whole gesture, as the composer sees it: a path to hand a worker, or nothing. */
export type PasteboardImageAttachment = () => Promise<string | undefined>;

/**
 * macOS synthesizes a PNG flavor for every image on the pasteboard — a TIFF-only screenshot, a
 * copied Photoshop layer, a dragged GIF all coerce — so one flavor covers the surface and the
 * written file always has the extension its bytes claim. A pasteboard holding text, files, or
 * nothing at all fails the coercion, which is the `no-image` branch and the whole of the
 * degrade-quietly path.
 */
const CAPTURE_SCRIPT: readonly string[] = [
  "on run argv",
  "set destination to item 1 of argv",
  "try",
  "set pasteboardImage to the clipboard as «class PNGf»",
  "on error",
  "return \"no-image\"",
  "end try",
  "set handle to open for access (POSIX file destination) with write permission",
  "set eof handle to 0",
  "write pasteboardImage to handle",
  "close access handle",
  "return \"captured\"",
  "end run",
];

/**
 * Bounds a wedged `osascript`. Captures run on the composer's serialized input queue, so this is
 * also the longest a keystroke can queue behind a paste; a megabyte screenshot settles in a
 * fraction of it.
 */
const CAPTURE_TIMEOUT_MS = 5_000;

/**
 * Images the directory keeps. An operator pastes a screenshot to get a worker to look at it once;
 * the file only has to outlive the worker's read, so the newest handful is generous and the cap
 * runs on every paste rather than on a schedule nothing would trigger.
 */
const RETAINED_IMAGES = 20;

/** Only files this module wrote are ever pruned. */
const PASTED_IMAGE_PATTERN = /^paste-\d{8}T\d{6}Z-[0-9a-f]{4}\.png$/u;

export const capturePasteboardImageWithOsascript: PasteboardCapture = (destination) =>
  new Promise((resolve) => {
    // Every other platform has no pasteboard to read and no `osascript` to read it with.
    if (process.platform !== "darwin") {
      resolve("no-image");
      return;
    }
    execFile(
      "osascript",
      [...CAPTURE_SCRIPT.flatMap((line) => ["-e", line]), destination],
      { timeout: CAPTURE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        // A missing binary, a denied read, a timeout: all indistinguishable to the operator from
        // "no image on the pasteboard", and all better answered by doing nothing than by a notice
        // on a chord they may have pressed out of habit.
        if (error !== null) {
          resolve("no-image");
          return;
        }
        resolve(stdout.trim() === "captured" ? "captured" : "no-image");
      },
    );
  });

export interface PasteboardImageOptions {
  /** Directory the image is written to. Created on demand. */
  directory: string;
  capture?: PasteboardCapture | undefined;
  now?: (() => number) | undefined;
  /** Test seam for the collision suffix. */
  suffix?: (() => string) | undefined;
}

/**
 * Capture the pasteboard image to a file and return its path, or `undefined` when the pasteboard
 * holds no image.
 *
 * The path is the point: a worker launches in its own process and cannot see the operator's
 * pasteboard, so the only thing worth putting in the composer is somewhere it can open.
 */
export async function capturePasteboardImage(
  options: PasteboardImageOptions,
): Promise<string | undefined> {
  const capture = options.capture ?? capturePasteboardImageWithOsascript;
  const now = options.now ?? Date.now;
  const suffix = options.suffix ?? randomSuffix;
  await mkdir(options.directory, { recursive: true });
  const destination = join(options.directory, `paste-${timestamp(now())}-${suffix()}.png`);
  if (await capture(destination) === "no-image") return undefined;
  await prune(options.directory);
  return destination;
}

/**
 * Names sort chronologically as text, which is what lets {@link prune} pick the oldest without
 * stat-ing anything. The random suffix separates two pastes landing in the same second.
 */
function timestamp(millis: number): string {
  return new Date(millis).toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
}

async function prune(directory: string): Promise<void> {
  try {
    const pasted = (await readdir(directory)).filter((name) => PASTED_IMAGE_PATTERN.test(name)).sort();
    for (const stale of pasted.slice(0, Math.max(0, pasted.length - RETAINED_IMAGES))) {
      await rm(join(directory, stale), { force: true });
    }
  } catch {
    // Housekeeping never costs the operator the paste they just made.
  }
}

/**
 * Splice an image path into the composer draft.
 *
 * The state directory lives under `Application Support`, so the path always contains a space and
 * always needs quoting: a prompt is read by a model, not a shell, and an unquoted path there reads
 * as two arguments-worth of words. The trailing space leaves the operator typing where they were.
 */
export function draftWithImageReference(draft: string, path: string): string {
  const reference = /\s/u.test(path) ? `"${path}"` : path;
  const separator = draft === "" || /\s$/u.test(draft) ? "" : " ";
  return `${draft}${separator}${reference} `;
}
