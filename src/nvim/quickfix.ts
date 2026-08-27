import type { NvimWorktreeRequest } from "../domain/worktree-review.js";

export {
  quickfixEntries,
  worktreeRequest,
  type NvimWorktreeRequest,
  type QuickfixEntry,
} from "../domain/worktree-review.js";

/**
 * Base64 so the payload can be one `--remote-expr` argument with no escaping question at all.
 *
 * A worktree path or a hunk's context line can contain quotes, backslashes, or newlines, every one
 * of which would otherwise have to survive both Vim expression parsing and argv. Base64's alphabet
 * contains none of them, so there is nothing left to get wrong.
 */
export function encodeNvimPayload(request: NvimWorktreeRequest): string {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64");
}

export function decodeNvimPayload(encoded: string): NvimWorktreeRequest {
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as NvimWorktreeRequest;
}
