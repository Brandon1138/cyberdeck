import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createPasteboardCapture } from "./clipboard-platform.js";
import { MAX_CLIPBOARD_IMAGE_BYTES, PNG_SIGNATURE } from "./clipboard-process.js";
export { capturePasteboardImageWithOsascript } from "./clipboard-platform.js";

/**
 * Reading an image out of the composer's paste path is not a decoding problem, it is an
 * out-of-band one. The fleet turns bracketed paste *off* on the shared pane, and even with it on a
 * terminal writes nothing to the pty for an image-only pasteboard: Cmd+V of a screenshot delivers
 * zero bytes, so there is no payload to inspect and no keypress to hang the feature off. The only
 * signal available is an explicit chord, which is why the composer binds ctrl+v and reads the
 * pasteboard here rather than parsing anything out of stdin.
 */
export type PasteboardCaptureOutcome =
  | { status: "captured" }
  | { status: "no-image" }
  /**
   * The clipboard could not be read at all — missing integration, a denied read or a timeout.
   * Separated from `no-image` because the two are not the same event: an empty pasteboard is the
   * operator pressing a chord over nothing, while an unreadable one may well be the screenshot
   * they just took going nowhere. The first is quiet and the second is said out loud.
   */
  | { status: "unavailable"; reason: string };

/** Write the pasteboard's image to `destination`, or report why nothing was written. */
export type PasteboardCapture = (destination: string) => Promise<PasteboardCaptureOutcome>;

/** The whole gesture, as the composer sees it. */
export type PasteboardImageResult =
  | { status: "captured"; path: string }
  | { status: "no-image" }
  | { status: "unavailable"; reason: string };

export type PasteboardImageAttachment = () => Promise<PasteboardImageResult>;

/**
 * Images the directory keeps. An operator pastes a screenshot to get a worker to look at it once;
 * the file only has to outlive the worker's read, so the newest handful is generous and the cap
 * runs on every paste rather than on a schedule nothing would trigger.
 */
const RETAINED_IMAGES = 20;
const CLEANUP_SCAN_LIMIT = 256;
const CLEANUP_DELETE_LIMIT = 20;

/** Only files this module wrote are ever pruned. */
const PASTED_IMAGE_PATTERN = /^paste-\d{8}T\d{6}Z-[0-9a-f]{4}\.png$/u;

export interface PasteboardImageOptions {
  /** Directory the image is written to. Created on demand. */
  directory: string;
  capture?: PasteboardCapture | undefined;
  now?: (() => number) | undefined;
  /** Test seam for the collision suffix. */
  suffix?: (() => string) | undefined;
}

/**
 * Capture the clipboard into private storage. Unknown integration failures remain visible.
 *
 * The path is the point: a worker launches in its own process and cannot see the operator's
 * pasteboard, so the only thing worth putting in the composer is somewhere it can open.
 */
export async function capturePasteboardImage(
  options: PasteboardImageOptions,
): Promise<PasteboardImageResult> {
  const capture = options.capture ?? createPasteboardCapture();
  const now = options.now ?? Date.now;
  const suffix = options.suffix ?? randomSuffix;
  let destination: string | undefined;
  try {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(options.directory);
    if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid())) {
      return { status: "unavailable", reason: "Clipboard image storage is not a private directory" };
    }
    await chmod(options.directory, 0o700);
    const time = timestamp(now());
    // Exclusive reservation preserves an existing image even when a filename collides.
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = suffix();
      if (!/^[0-9a-f]{4}$/u.test(id)) throw new Error("Invalid image suffix");
      const candidate = join(options.directory, `paste-${time}-${id}.png`);
      try {
        const file = await open(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        destination = candidate;
        await file.close();
        break;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    if (destination === undefined) return { status: "unavailable", reason: "Could not reserve a clipboard image file" };
    const outcome = await capture(destination);
    if (outcome.status !== "captured") return outcome;
    const invalid = await validateImage(destination);
    if (invalid !== undefined) return { status: "unavailable", reason: invalid };
    await prune(options.directory, destination);
    const path = destination;
    destination = undefined; // The validated attachment now owns this file.
    return { status: "captured", path };
  } catch {
    return { status: "unavailable", reason: "Could not capture the clipboard image in private storage" };
  } finally {
    if (destination !== undefined) await rm(destination, { force: true }).catch(() => undefined);
  }
}

async function validateImage(path: string): Promise<string | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
      return "Clipboard image destination is not a private file";
    }
    if (stat.size > MAX_CLIPBOARD_IMAGE_BYTES) return "Clipboard image exceeds 20 MiB";
    const header = Buffer.alloc(PNG_SIGNATURE.length);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || !header.equals(PNG_SIGNATURE)) return "Clipboard image is not a PNG";
    await file.chmod(0o600);
    return undefined;
  } finally { await file.close(); }
}

/**
 * Names sort chronologically as text, which is what lets {@link prune} pick the oldest without
 * stat-ing anything. The random suffix separates two pastes landing in the same second.
 */
function timestamp(millis: number): string {
  return new Date(millis).toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
}

function randomSuffix(): string {
  return randomBytes(2).toString("hex");
}

async function prune(directory: string, current: string): Promise<void> {
  try {
    const pasted: string[] = [];
    let scanned = 0;
    for await (const entry of await opendir(directory)) {
      if (entry.isFile() && PASTED_IMAGE_PATTERN.test(entry.name)) pasted.push(entry.name);
      if (++scanned >= CLEANUP_SCAN_LIMIT) break;
    }
    pasted.sort();
    const staleCount = Math.min(CLEANUP_DELETE_LIMIT, Math.max(0, pasted.length - RETAINED_IMAGES));
    for (const stale of pasted.filter((name) => join(directory, name) !== current).slice(0, staleCount)) {
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

/**
 * Extensions a paste or a drop actually produces, and that a CLI attachment flag actually takes.
 * Deliberately short: every entry added here is a file type some provider will refuse to open, and
 * a launch argument that makes the CLI exit is worse than a path left as prose.
 */
const IMAGE_EXTENSIONS = "png|jpe?g|gif|webp";

/** A quoted absolute path: the shape {@link draftWithImageReference} writes for a path with spaces. */
const QUOTED_IMAGE_REFERENCE = new RegExp(`"(/[^"\\n]+\\.(?:${IMAGE_EXTENSIONS}))"`, "giu");

/**
 * A bare absolute path, with macOS's drag-and-drop escaping accepted: dropping a file onto a
 * terminal types its path in, and a path with a space arrives as `/Users/me/screen\ shot.png`.
 */
const BARE_IMAGE_REFERENCE = new RegExp(
  `(?<![\\w"'])(/(?:[^\\s"'\\\\]|\\\\.)+\\.(?:${IMAGE_EXTENSIONS}))(?![\\w])`,
  "giu",
);

/**
 * The images a draft is asking a worker to look at.
 *
 * The draft *is* the record — there is no hidden attachment list that could disagree with what the
 * operator can see. Deleting the path deletes the attachment, and a path typed or dropped in by
 * hand attaches exactly as a pasted one does, because by the time either reaches the composer they
 * are the same characters.
 *
 * Only absolute paths count. A relative one is far more likely to be prose about a file in the
 * repository than a file the operator means to hand over, and guessing which would attach things
 * nobody asked for.
 */
export function composerImageAttachments(draft: string): string[] {
  const found: string[] = [];
  const remainder = draft.replace(QUOTED_IMAGE_REFERENCE, (match, path: string) => {
    found.push(path);
    // Blanked rather than dropped so the bare scan cannot re-read a quoted path, and so no two
    // neighbouring words are joined into a path that was never written.
    return " ".repeat(match.length);
  });
  for (const match of remainder.matchAll(BARE_IMAGE_REFERENCE)) {
    found.push(match[1]!.replace(/\\(.)/gu, "$1"));
  }
  return [...new Set(found)];
}
