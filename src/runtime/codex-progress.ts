/** A changed response/tool body is progress; a spinner, elapsed clock or draft is not. */
export class CodexScreenProgress {
  private previous: string | undefined;
  private revision = 0;
  reset(): void { this.previous = undefined; this.revision = 0; }
  observe(frame: string): number {
    const lines = frame.split("\n");
    // Use the current busy footer, never a quoted historical Working line in the response.
    const footer = lines.findLastIndex(line => /^\s*[^\p{L}\p{N}]*Working\s*\([^\n]*esc to interrupt/iu.test(line));
    if (footer < 0) return this.revision;
    const body = lines.slice(0, footer).map(line => line.trimEnd()).join("\n").trim();
    if (body && body !== this.previous) { this.previous = body; this.revision++; }
    return this.revision;
  }
}
