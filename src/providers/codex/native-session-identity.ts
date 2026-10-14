/** An exact actor marker injected at launch, never recovered from user or assistant prose. */
export function codexSessionMarker(sessionId: string): string {
  return `[cyberdeck-native-session:${sessionId}]`;
}

export function codexDeveloperInstructions(sessionId: string, instructions?: string): string {
  if (instructions?.split(/\r?\n/u).includes(codexSessionMarker(sessionId))) return instructions;
  return [instructions, codexSessionMarker(sessionId)].filter((value) => value !== undefined).join("\n\n");
}

/** Only the provider's developer-instruction records can establish launch attribution. */
export function codexSessionClaims(line: string): string[] {
  try {
    const frame = JSON.parse(line) as { type?: unknown; payload?: {
      type?: unknown; role?: unknown; content?: unknown; developer_instructions?: unknown;
    } };
    const payload = frame.payload;
    const texts = frame.type === "turn_context" && typeof payload?.developer_instructions === "string"
      ? [payload.developer_instructions]
      : frame.type === "response_item" && payload?.type === "message" && payload.role === "developer"
        && Array.isArray(payload.content)
        ? payload.content.flatMap((block: unknown) => {
          const value = block as { type?: unknown; text?: unknown } | null;
          return value?.type === "input_text" && typeof value.text === "string" ? [value.text] : [];
        }) : [];
    const claims = new Set(texts.flatMap((text) => [...text.matchAll(
      /^\[cyberdeck-native-session:([0-9a-f-]{36})\]$/gimu,
    )].map((match) => match[1]!)));
    return [...claims];
  } catch { return []; }
}
