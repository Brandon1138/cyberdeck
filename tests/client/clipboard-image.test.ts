import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

const directories: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-paste-"));
  directories.push(directory);
  return directory;
}

/** Stands in for the pasteboard: writes the bytes a real capture would have written. */
function withImage(bytes = "png-bytes"): PasteboardCapture {
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
    await expect(readFile(path, "utf8")).resolves.toBe("png-bytes");
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
});

describe("capturePasteboardImageWithOsascript", () => {
  it("reports no image rather than failing when the platform has no pasteboard to read", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      await expect(capturePasteboardImageWithOsascript("/nowhere/paste.png"))
        .resolves.toEqual({ status: "no-image" });
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
