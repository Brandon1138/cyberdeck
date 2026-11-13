/**
 * Present history without asking the attaching terminal to answer old provider probes again.
 * Those answers are fresh stdin, which would otherwise be attributed to the operator and fence
 * the session's native idle boundary. Live output still travels unchanged.
 */
export function attachmentReplay(bytes: Buffer): Buffer {
  // Latin-1 keeps a one-to-one mapping to bytes; printable UTF-8 is never decoded or rewritten.
  const replay = bytes.toString("latin1");
  const presented = replay
    .replace(/\u001b\[[0-?]*[ -/]*[cn]/gu, "") // Device attributes and device-status reports.
    .replace(/\u001b\[\?u/gu, "") // Kitty keyboard protocol query; retain push/pop/set modes.
    .replace(/\u001b\[>[0-9]*q/gu, "") // Terminal version query.
    .replace(/\u001b\[[?0-9;]*\$p/gu, "") // DECRQM mode query.
    .replace(/\u001b\](?:(?:10|11|12);|4;[0-9]+;)\?(?:\u0007|\u001b\\)/gu, "");
  return presented === replay ? bytes : Buffer.from(presented, "latin1");
}
