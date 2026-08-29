import type { ProviderId } from "./session.js";

/**
 * How a provider's CLI takes an image — read off the CLI's own `--help`, never inferred from the
 * model behind it.
 *
 * A model that can see images is not a CLI that can be handed one. The question this answers is the
 * narrow one the composer has to ask before it writes a PNG to disk: given a path, is there a
 * documented way for *this executable* to open it?
 *
 * - `launch-flag` — the CLI advertises an attachment flag, so the image travels as a launch
 *   argument and arrives as an attachment rather than as prose that happens to name a file.
 * - `prompt-path` — no flag, but the CLI reads files named in its prompt with its own file reader,
 *   which for an image means it is opened and looked at. One step less direct than an attachment,
 *   and the operator is told so rather than left to assume parity.
 * - `none` — nothing to hand a path to. Every surface that reaches this branch must refuse out
 *   loud; silently launching with a path the CLI will read as words is the failure MIK-78 names.
 */
export type ProviderImageInput =
  | {
    kind: "launch-flag";
    /** The CLI flag each path is passed with, one flag per path. */
    flag: string;
    /** Named in the composer's notice so the operator knows which mechanism carried the image. */
    mechanism: string;
  }
  | { kind: "prompt-path"; mechanism: string }
  | {
    kind: "none";
    /**
     * Quoted verbatim in every refusal, so it has to say what was looked for and not found rather
     * than merely that the answer is no.
     */
    reason: string;
  };

/**
 * Probed on 2026-08-17 against the operator's installed CLIs: codex-cli 0.147.0, Claude Code
 * 2.1.233, cursor-agent 2026.08.11-e8db854, agy 1.1.13. `codex --help` is the only one of the four
 * that advertises an image flag. A CLI that grows one later belongs here as a `launch-flag` entry
 * with its own adapter change — not as a widened guess about what a path in a prompt might do.
 */
export const PROVIDER_IMAGE_INPUT: Readonly<Record<string, ProviderImageInput>> = {
  codex: {
    kind: "launch-flag",
    // `-i, --image <FILE>...  Optional image(s) to attach to the initial prompt`.
    flag: "-i",
    mechanism: "codex -i",
  },
  claude: {
    kind: "prompt-path",
    mechanism: "path in prompt; Claude opens the file",
  },
  cursor: {
    kind: "none",
    reason: "cursor-agent advertises no image flag and no path attachment",
  },
  antigravity: {
    kind: "none",
    reason: "agy advertises no image flag and no path attachment",
  },
};

/**
 * A provider nobody has probed is refused, not assumed capable. `ProviderId` is an open slug, so
 * this branch is reachable by any adapter registered after this table was written, and a launch
 * that quietly drops the image is exactly what a missing declaration must not buy.
 */
export function providerImageInput(provider: ProviderId): ProviderImageInput {
  return PROVIDER_IMAGE_INPUT[provider] ?? {
    kind: "none",
    reason: `Cyberdeck has no image-input declaration for ${provider}`,
  };
}

/** Whether a path handed to this provider reaches the model as an image at all. */
export function providerAcceptsImages(provider: ProviderId): boolean {
  return providerImageInput(provider).kind !== "none";
}

/**
 * Whether images travel to this provider as launch arguments.
 *
 * This is the exact meaning of `StartSessionRequest.imageAttachments`: a `prompt-path` provider
 * carries its image in the prompt text and must be given no attachment list, or the record would
 * claim an attachment no launch argument ever made.
 */
export function providerAttachesImagesAtLaunch(provider: ProviderId): boolean {
  return providerImageInput(provider).kind === "launch-flag";
}

/**
 * How an image reaches this provider, in the few words a one-line notice has room for. A provider
 * that takes none answers with the reason it takes none, so no caller can print an empty mechanism.
 */
export function providerImageMechanism(provider: ProviderId): string {
  const input = providerImageInput(provider);
  return input.kind === "none" ? input.reason : input.mechanism;
}

/** The launch arguments that attach `paths`, or none for a provider that takes no flag. */
export function providerImageLaunchArgs(
  provider: ProviderId,
  paths: readonly string[],
): string[] {
  const input = providerImageInput(provider);
  if (input.kind !== "launch-flag") return [];
  return paths.flatMap((path) => [input.flag, path]);
}

/**
 * The one sentence every surface refuses with. One wording in one place so the composer's notice
 * and the broker's rejection cannot describe the same limitation differently.
 */
export function imageInputRefusal(provider: ProviderId, imageCount = 1): string {
  const input = providerImageInput(provider);
  const subject = imageCount === 1 ? "an image" : `${imageCount} images`;
  if (input.kind === "none") {
    return `${titleCase(provider)} cannot be given ${subject}: ${input.reason}`;
  }
  // Reached only when a caller passes attachments to a provider that reads its images out of the
  // prompt: the paths are already where they belong, and a second copy as launch arguments would
  // be dropped without a word.
  return `${titleCase(provider)} takes ${subject} as ${input.mechanism}, not as a launch attachment`;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
