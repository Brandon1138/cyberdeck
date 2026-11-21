/** A rendered build decision includes all three boxed choices below its heading. */
export const CURSOR_BUILD_PROMPT = /^[ \t]*│[ \t]*Ready to build\?[ \t]*│\s*│[ \t]*(?:│\s*│[ \t]*)?(?:→[ \t]*)?1\. Yes, build locally \(b\)[ \t]*│\s*│[ \t]*(?:→[ \t]*)?2\. Yes, build in cloud \(c\)[ \t]*│\s*│[ \t]*(?:→[ \t]*)?3\. No, propose changes \(p or Esc\)[ \t]*│/gimu;

/** Read the bottom input row and its adjacent Cursor status bar from a rendered screen. */
export function cursorComposer(frame: string): { content: string; working: boolean } | undefined {
  const lines = [...frame.matchAll(/[^\n]+/gu)].filter(row => row[0].trim());
  const last = lines.length - 1;
  for (let i = last; i >= Math.max(0, last - 6); i--) {
    const row = lines[i]!;
    const prompt = /^[→›❯](?:\s+(.*))?$/u.exec(row[0].trim());
    if (!prompt) continue;
    const footer = lines.slice(i + 1).map(line => line[0].trim()).filter(line => !/^[─━═]+$/u.test(line));
    if (footer.length && !isStatusBar(footer)) return undefined;
    const input = prompt[1] ?? "";
    // Cursor right-aligns this control on the same row as the editable draft.
    const stop = /\s{2,}ctrl\+c to stop$/iu.exec(input);
    return { content: stop ? input.slice(0, stop.index).trimEnd() : input, working: !!stop };
  }
  return undefined;
}

function isStatusBar(rows: string[]): boolean {
  const [first, ...remaining] = rows;
  if (!first) return false;
  const hasMode = /^(?:(?:Plan|Ask|Agent) \(shift\+tab to cycle\)|\d+ tasks?)$/iu.test(first);
  const footer = hasMode ? remaining : rows;
  const [model, second] = footer;
  const effortWrap = /^(?:Low|Medium|High|Extra High|Auto)(?:\s+edited)?$/iu.test(second ?? "");
  const [path, branch, ...extra] = footer.slice(effortWrap ? 2 : 1);
  // The cwd and branch may wrap across two rows on a narrow PTY.
  // Fresh conversations have a model and cwd before Cursor draws its first context meter.
  const freshModel = hasMode && /^(?:Claude|GPT|Composer|Grok|Gemini) [\w .()/-]+$/iu.test(model ?? "");
  return !extra.length && !!model && (freshModel || /^[\w][\w .()/-]*\s*·\s*\d+(?:\.\d+)?%(?:\s*·\s*\d+ files?(?: edited)?)?(?:\s+Run Everything)?$/iu.test(model))
    && !!path && /^(?:~\/|\/)[^\n]*$/u.test(path)
    && (branch === undefined || /·$/u.test(path) && /^[\w./-]+$/u.test(branch));
}

/** Cursor's narrow status bar wraps the usage meter, effort and cwd below its input. */
export function cursorFooterStart(lines: readonly string[]): number {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  if (!/^(?:~(?:\/|$)|\/|[A-Z]:\\)/iu.test(lines[end - 1]?.trim() ?? "")) return lines.length;
  let index = end - 2;
  if (/^(?:Low|Medium|High|Extra High|Auto)(?:\s+edited)?$/iu.test(lines[index]?.trim() ?? "")) index--;
  const meter = lines[index]?.trim() ?? "";
  return /^\S[^\n]*?\s+\d+(?:\.\d+)?[KM]\s*·\s*[\d.]+%/iu.test(meter) ? index : lines.length;
}

export function isCursorWorkingLine(line: string): boolean {
  if (/^[→›❯]\s+Add a follow-up\s{2,}ctrl\+c to stop$/iu.test(line)
      || /^[\u2800-\u28ff]+\s+Editing\s+[\d.,]+[km]?\s+tokens?$/iu.test(line)) return true;
  if (/^[\u2800-\u28ff]{2}\s+Working(?:\s+[\d.,]+[km]? tokens?)?$/iu.test(line)) return true;
  return /^(?:[\u2800-\u28ff]\s*)?Composing(?:\s+[\d.,]+[km]?\s+tokens?)?(?:\s+(?:ctrl\+c to stop|[·(].*))?$/iu.test(line)
    || /^ctrl\+c to stop(?:\s*[·)].*)?$/iu.test(line);
}

export function cursorComposerActivity(frame: string, blocked: boolean, working: boolean) {
  const composer = cursorComposer(frame);
  if (!composer) return undefined;
  if (blocked) return "needs-input";
  if (composer.working || working) return "working";
  if (!/^(?:\d+[.)]\s|Yes\b|No,?\s|Upgrade your plan)/iu.test(composer.content)) return "awaiting-input";
  return undefined;
}
