/** Footer positions prevent trust-dialog prose or paths from outranking the dialog itself. */
export function startupDialogPosition(tail: string): number {
  return Math.max(
    lastFooterPosition(tail, /^[ \t]*Folder[ \t]*access[ \t]*$[\s\S]{0,1600}?^[ \t]*enter[ \t]*continue[^\n]{0,40}?esc[ \t]*(?:quit|back|cancel)[ \t]*$/gimu),
    lastFooterPosition(tail, /^[ \t]*Hooks[ \t]*need[ \t]*review[ \t]*$[\s\S]{0,1200}?^[ \t]*(?:enter[ \t]*confirm[^\n]{0,40}?esc[ \t]*skip|Press[ \t]*enter[ \t]*to[ \t]*confirm[ \t]*or[ \t]*esc[ \t]*to[ \t]*go[ \t]*back)[ \t]*$/gimu),
    lastFooterPosition(
      tail,
      /^[ \t]*Do[ \t]*you[ \t]*trust[ \t]*the[ \t]*contents[ \t]*of[ \t]*this[ \t]*directory\?[^\n]*[\s\S]{0,1600}?^[ \t]*Press[ \t]*enter[ \t]*to[ \t]*continue[ \t]*$/gimu,
    ),
  );
}

/**
 * Offset of the last footer character: where a dialog whose body can hold an activity marker ends.
 *
 * A folder dialog prints its folder, and a path can say "Working" as readily as Codex 0.120 through
 * 0.153's own trust paragraph does ("Working with untrusted contents…"). Placed at its title, such
 * a dialog reads as older than the marker drawn inside it, and a blocked worker reads as busy.
 */
function lastFooterPosition(value: string, pattern: RegExp): number {
  let end = -1;
  for (const match of value.matchAll(pattern)) end = match.index + match[0].trimEnd().length - 1;
  return end;
}
