import { describe, expect, it } from "vitest";
import {
  PROVIDER_IMAGE_INPUT,
  imageInputRefusal,
  providerAcceptsImages,
  providerAttachesImagesAtLaunch,
  providerImageInput,
  providerImageLaunchArgs,
  providerImageMechanism,
} from "../../src/providers/image-input.js";

describe("provider image input", () => {
  // The declarations are read off each CLI's own `--help`, so this is the shape of what was found
  // there on 2026-08-17: one attachment flag, one file-reading prompt, and two CLIs that advertise
  // neither. A CLI that grows an image flag changes this test on purpose.
  it("declares codex as the only CLI advertising an attachment flag", () => {
    expect(PROVIDER_IMAGE_INPUT.codex).toEqual({
      kind: "launch-flag",
      flag: "-i",
      mechanism: "codex -i",
    });
    expect(PROVIDER_IMAGE_INPUT.claude?.kind).toBe("prompt-path");
    expect(PROVIDER_IMAGE_INPUT.cursor?.kind).toBe("none");
    expect(PROVIDER_IMAGE_INPUT.antigravity?.kind).toBe("none");
  });

  it("accepts images for the two CLIs that can open a path, and refuses the rest", () => {
    expect(providerAcceptsImages("codex")).toBe(true);
    expect(providerAcceptsImages("claude")).toBe(true);
    expect(providerAcceptsImages("cursor")).toBe(false);
    expect(providerAcceptsImages("antigravity")).toBe(false);
  });

  // Only a launch flag makes an attachment list mean anything. Claude carries its image in the
  // prompt text, so a list handed to it would be dropped by the launch without a word.
  it("attaches at launch only for a provider with a flag to carry the paths", () => {
    expect(providerAttachesImagesAtLaunch("codex")).toBe(true);
    expect(providerAttachesImagesAtLaunch("claude")).toBe(false);
    expect(providerAttachesImagesAtLaunch("cursor")).toBe(false);
  });

  it("builds one flag per path, and no arguments for a provider without one", () => {
    expect(providerImageLaunchArgs("codex", ["/tmp/a.png", "/tmp/b.png"]))
      .toEqual(["-i", "/tmp/a.png", "-i", "/tmp/b.png"]);
    expect(providerImageLaunchArgs("claude", ["/tmp/a.png"])).toEqual([]);
    expect(providerImageLaunchArgs("cursor", ["/tmp/a.png"])).toEqual([]);
  });

  // `ProviderId` is an open slug, so an adapter registered after this table was written lands here.
  // Refusing it is the point: a missing declaration must not buy a launch that drops the image.
  it("refuses a provider nobody has declared rather than assuming it can be handed a path", () => {
    expect(providerImageInput("newcomer")).toEqual({
      kind: "none",
      reason: "Cyberdeck has no image-input declaration for newcomer",
    });
    expect(providerAcceptsImages("newcomer")).toBe(false);
    expect(imageInputRefusal("newcomer"))
      .toBe("Newcomer cannot be given an image: Cyberdeck has no image-input declaration for newcomer");
  });

  it("says what was looked for and not found, and counts the images it is refusing", () => {
    expect(imageInputRefusal("cursor")).toBe(
      "Cursor cannot be given an image: cursor-agent advertises no image flag and no path attachment",
    );
    expect(imageInputRefusal("antigravity", 3)).toBe(
      "Antigravity cannot be given 3 images: agy advertises no image flag and no path attachment",
    );
  });

  // A caller that hands attachments to a path-reading provider is not told "no images"; it is told
  // where its images already belong.
  it("tells a prompt-path provider's caller that its images travel in the prompt", () => {
    expect(imageInputRefusal("claude", 2))
      .toBe("Claude takes 2 images as path in prompt; Claude opens the file, not as a launch attachment");
  });

  it("never answers with an empty mechanism", () => {
    for (const provider of ["codex", "claude", "cursor", "antigravity", "newcomer"]) {
      expect(providerImageMechanism(provider).length).toBeGreaterThan(0);
    }
  });
});
