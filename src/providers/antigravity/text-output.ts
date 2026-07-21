export const DEFAULT_ANTIGRAVITY_OUTPUT_LIMIT_BYTES = 1024 * 1024;

/** Bounded byte collector for `agy`'s help-advertised plain-text output. */
export class AntigravityTextCollector {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes = DEFAULT_ANTIGRAVITY_OUTPUT_LIMIT_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("maxBytes must be a positive safe integer");
    }
  }

  push(chunk: Buffer): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > this.maxBytes) {
      throw new AntigravityOutputLimitError(this.maxBytes);
    }
    this.chunks.push(Buffer.from(chunk));
  }

  text(): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(this.chunks));
    } catch (error) {
      throw new AntigravityMalformedOutputError(
        error instanceof Error ? error.message : "invalid UTF-8 output",
      );
    }
  }
}

export class AntigravityOutputLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Antigravity output exceeded the bounded ${String(maxBytes)} byte limit`);
    this.name = "AntigravityOutputLimitError";
  }
}

export class AntigravityMalformedOutputError extends Error {
  constructor(reason: string) {
    super(`Antigravity emitted malformed UTF-8 output: ${reason}`);
    this.name = "AntigravityMalformedOutputError";
  }
}
