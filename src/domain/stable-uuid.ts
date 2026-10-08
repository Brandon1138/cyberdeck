import { createHash } from "node:crypto";

/**
 * A deterministic UUID-shaped id derived from a seed.
 *
 * Broker-owned instructions and notices are retried across restarts, and the retry must find the
 * record it already wrote rather than enqueue a second copy. The seed is the identity; the shape
 * only exists because the instruction and notification schemas validate `messageId` as a UUID.
 * Two broker modules carried private copies of this; this is the one place it is defined.
 */
export function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "8";
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}
