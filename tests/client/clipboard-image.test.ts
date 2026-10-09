import { chmod, link, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capturePasteboardImage,
  capturePasteboardImageWithOsascript,
  composerImageAttachments,
  draftWithImageReference,
  type PasteboardCapture,
} from "../../src/client/clipboard-image.js";
import { MAX_CLIPBOARD_IMAGE_BYTES } from "../../src/client/clipboard-process.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");

const directories: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-paste-"));
  directories.push(directory);
  return directory;
}

/** Stands in for the pasteboard: writes the bytes a real capture would have written. */
function withImage(bytes: Buffer | string = PNG): PasteboardCapture {
  return async (destination) => {
    await writeFile(destination, bytes);
    return { status: "captured" };
  };
}

const withoutImage: PasteboardCapture = async () => ({ status: "no-image" });

const unreadable: PasteboardCapture = async () => ({
  status: "unavailable",
  reason: "spawn osascript ETIMEDOUT",
});

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("capturePasteboardImage", () => {
  it("writes the pasteboard image into a directory it creates and returns its path", async () => {
    const directory = join(await scratch(), "pasted-images");
    const capture = vi.fn(withImage());

    const result = await capturePasteboardImage({
      directory,
      capture,
      now: () => Date.UTC(2026, 6, 29, 14, 33, 55),
      suffix: () => "abcd",
    });

    const path = join(directory, "paste-20260729T143355Z-abcd.png");
    expect(result).toEqual({ status: "captured", path });
    expect(capture).toHaveBeenCalledWith(path);
    await expect(readFile(path)).resolves.toEqual(PNG);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("reports nothing and leaves no file behind for a pasteboard without an image", async () => {
    const directory = await scratch();

    await expect(capturePasteboardImage({ directory, capture: withoutImage }))
      .resolves.toEqual({ status: "no-image" });
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  // A pasteboard that could not be read is not a pasteboard known to be empty: the reason travels
  // out so the operator hears about a screenshot that went nowhere instead of nothing at all.
  it("distinguishes a pasteboard it could not read from one holding no image", async () => {
    const directory = await scratch();

    await expect(capturePasteboardImage({ directory, capture: unreadable })).resolves.toEqual({
      status: "unavailable",
      reason: "spawn osascript ETIMEDOUT",
    });
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("keeps the newest images and never prunes a file it did not write", async () => {
    const directory = await scratch();
    await writeFile(join(directory, "config.json"), "{}");
    for (let index = 0; index < 25; index += 1) {
      await capturePasteboardImage({
        directory,
        capture: withImage(),
        now: () => Date.UTC(2026, 6, 29, 14, 0, index),
        suffix: () => "0000",
      });
    }

    const remaining = (await readdir(directory)).sort();
    expect(remaining).toContain("config.json");
    const pasted = remaining.filter((name) => name.startsWith("paste-"));
    expect(pasted).toHaveLength(20);
    // The survivors are the last twenty seconds' worth: pruning is oldest-first.
    expect(pasted[0]).toBe("paste-20260729T140005Z-0000.png");
    expect(pasted.at(-1)).toBe("paste-20260729T140024Z-0000.png");
  });

  it("makes existing clipboard storage private before the reader writes", async () => {
    const directory = await scratch();
    await chmod(directory, 0o755);
    const capture: PasteboardCapture = async (destination) => {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
      return withImage()(destination);
    };
    expect((await capturePasteboardImage({ directory, capture })).status).toBe("captured");
  });

  it.each(["", "JPEG data", "clipboard text containing secrets"])("rejects invalid PNG bytes and removes failed capture: %j", async (bytes) => {
    const directory = await scratch();
    await expect(capturePasteboardImage({ directory, capture: withImage(bytes) }))
      .resolves.toEqual({ status: "unavailable", reason: "Clipboard image is not a PNG" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects oversized captured files without reading their full contents", async () => {
    const directory = await scratch();
    const capture: PasteboardCapture = async (path) => {
      const file = await open(path, "w");
      try { await file.write(PNG); await file.truncate(MAX_CLIPBOARD_IMAGE_BYTES + 1); }
      finally { await file.close(); }
      return { status: "captured" };
    };
    await expect(capturePasteboardImage({ directory, capture }))
      .resolves.toEqual({ status: "unavailable", reason: "Clipboard image exceeds 20 MiB" });
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["no-image", "unavailable", "throw"] as const)("removes a partial capture when reader reports %s", async (outcome) => {
    const directory = await scratch();
    const capture: PasteboardCapture = async (path) => {
      await writeFile(path, PNG);
      if (outcome === "throw") throw new Error("secret clipboard output");
      return outcome === "no-image" ? { status: outcome } : { status: outcome, reason: "Reader unavailable" };
    };
    const result = await capturePasteboardImage({ directory, capture });
    expect(result.status).toBe(outcome === "no-image" ? "no-image" : "unavailable");
    expect(JSON.stringify(result)).not.toContain("secret clipboard output");
    expect(await readdir(directory)).toEqual([]);
  });

  it("preserves an existing image on filename collision", async () => {
    const directory = await scratch();
    const now = () => Date.UTC(2026, 6, 29, 14, 33, 55);
    const existing = join(directory, "paste-20260729T143355Z-abcd.png");
    await writeFile(existing, "existing attachment");
    const ids = ["abcd", "1234"];
    const result = await capturePasteboardImage({ directory, capture: withImage(), now, suffix: () => ids.shift()! });
    expect(result).toEqual({ status: "captured", path: join(directory, "paste-20260729T143355Z-1234.png") });
    expect(await readFile(existing, "utf8")).toBe("existing attachment");
  });

  it("rejects a linked directory without touching its files", async () => {
    const directory = await scratch();
    const target = await scratch();
    await writeFile(join(target, "keep.txt"), "keep");
    const linked = join(directory, "linked");
    await symlink(target, linked);
    const capture = vi.fn(withImage());
    expect((await capturePasteboardImage({ directory: linked, capture })).status).toBe("unavailable");
    expect(capture).not.toHaveBeenCalled();
    expect(await readdir(target)).toEqual(["keep.txt"]);
  });

  it.each(["symlink", "hardlink"] as const)("rejects a substituted %s without changing external file permissions", async (kind) => {
    const directory = await scratch();
    const external = join(await scratch(), "external.png");
    await writeFile(external, PNG, { mode: 0o644 });
    const capture: PasteboardCapture = async (path) => {
      await rm(path);
      if (kind === "symlink") await symlink(external, path);
      else await link(external, path);
      return { status: "captured" };
    };
    expect((await capturePasteboardImage({ directory, capture })).status).toBe("unavailable");
    expect(await readdir(directory)).toEqual([]);
    expect(await readFile(external)).toEqual(PNG);
    expect((await stat(external)).mode & 0o777).toBe(0o644);
  });

  it("caps housekeeping work and leaves unrelated entries and links alone", async () => {
    const directory = await scratch();
    for (let index = 0; index < 90; index++) {
      const time = String(index).padStart(6, "0");
      await writeFile(join(directory, `paste-20260101T${time}Z-0000.png`), PNG);
    }
    const external = join(await scratch(), "external.png");
    await writeFile(external, PNG);
    const linked = join(directory, "paste-20200101T000000Z-0000.png");
    await symlink(external, linked);
    await writeFile(join(directory, "notes.txt"), "keep");
    expect((await capturePasteboardImage({ directory, capture: withImage() })).status).toBe("captured");
    expect((await readdir(directory)).filter((name) => name.startsWith("paste-"))).toHaveLength(72);
    expect(await readFile(linked)).toEqual(PNG);
    expect(await readFile(join(directory, "notes.txt"), "utf8")).toBe("keep");
  });
});

describe("capturePasteboardImageWithOsascript", () => {
  it("reports unavailable rather than claiming an empty clipboard on another platform", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      await expect(capturePasteboardImageWithOsascript("/nowhere/paste.png"))
        .resolves.toEqual({ status: "unavailable", reason: "osascript clipboard integration requires macOS" });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});

describe("draftWithImageReference", () => {
  it("quotes the path so a state-directory space cannot split it into two words", () => {
    expect(draftWithImageReference("", "/Users/one/Library/Application Support/Cyberdeck/a.png"))
      .toBe("\"/Users/one/Library/Application Support/Cyberdeck/a.png\" ");
  });

  it("leaves a path without whitespace unquoted", () => {
    expect(draftWithImageReference("", "/tmp/a.png")).toBe("/tmp/a.png ");
  });

  it("separates the reference from what the operator already typed, exactly once", () => {
    expect(draftWithImageReference("Look at this", "/tmp/a.png")).toBe("Look at this /tmp/a.png ");
    expect(draftWithImageReference("Look at this ", "/tmp/a.png")).toBe("Look at this /tmp/a.png ");
    expect(draftWithImageReference("Look at this\n", "/tmp/a.png")).toBe("Look at this\n/tmp/a.png ");
  });
});

describe("composerImageAttachments", () => {
  it("reads back exactly what a paste spliced in, quoting and all", () => {
    const path = "/Users/one/Library/Application Support/Cyberdeck/pasted-images/paste-a.png";

    expect(composerImageAttachments(draftWithImageReference("Look at this", path))).toEqual([path]);
  });

  it("accepts a path the operator typed or dropped, including drag-and-drop space escaping", () => {
    expect(composerImageAttachments("compare /tmp/before.png with /tmp/after.jpeg")).toEqual([
      "/tmp/before.png",
      "/tmp/after.jpeg",
    ]);
    expect(composerImageAttachments("look at /Users/one/screen\\ shot.png")).toEqual([
      "/Users/one/screen shot.png",
    ]);
  });

  it("ignores anything that is not an absolute path to an image", () => {
    // Prose about a file in the repository is prose, not a handover.
    expect(composerImageAttachments("regenerate docs/diagram.png from the source")).toEqual([]);
    expect(composerImageAttachments("read /etc/hosts and /tmp/report.pdf")).toEqual([]);
    expect(composerImageAttachments("")).toEqual([]);
  });

  it("counts one path once however many times it appears", () => {
    expect(composerImageAttachments("/tmp/a.png then /tmp/a.png again")).toEqual(["/tmp/a.png"]);
  });

  // The draft is the record: deleting the reference has to delete the attachment, or the launch
  // would carry an image the operator can no longer see on screen.
  it("returns nothing once the operator deletes the reference", () => {
    const draft = draftWithImageReference("Look at this", "/tmp/a.png");

    expect(composerImageAttachments(draft.replace("/tmp/a.png", ""))).toEqual([]);
  });
});
