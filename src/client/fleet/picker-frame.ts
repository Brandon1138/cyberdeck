import { stripTerminalControl } from "../../domain/terminal-replay.js";
import { paint } from "./slash-commands.js";

export function pickerRow(value: string, selected: boolean, color: boolean): string {
  return `${paint(selected ? "›" : "·", selected ? "bold" : "dim", color)} ${selected ? paint(value, "bold", color) : value}`;
}

/**
 * A cursorless picker still needs a visible interaction anchor in a very short pane.
 *
 * Every selected picker row — including the directed-handoff draft — starts with `›`. Keep that
 * row inside the body window, and when the footer itself would consume the pane, spend the first
 * physical row on the selection before retaining as many trailing hints as still fit. This is a
 * visual anchor only; it never turns a picker into a terminal caret owner.
 */
export function renderCursorlessPickerFrame(
  lines: readonly string[],
  footer: readonly string[],
  height: number,
  priorityFooterRows = 0,
): string {
  const frameHeight = Math.max(1, height);
  const selectedIndex = lines.findLastIndex((line) =>
    stripTerminalControl(line).startsWith("› "));
  const fallbackIndex = lines.findLastIndex((line) => stripTerminalControl(line).trim() !== "");
  const anchorIndex = Math.max(0, selectedIndex === -1 ? fallbackIndex : selectedIndex);

  if (frameHeight <= footer.length) {
    const footerCapacity = frameHeight - 1;
    const priorityFooter = footer.slice(0, Math.min(priorityFooterRows, footerCapacity));
    const trailingCapacity = footerCapacity - priorityFooter.length;
    const trailingFooter = trailingCapacity === 0
      ? []
      : footer.slice(priorityFooterRows).slice(-trailingCapacity);
    const visibleFooter = [...priorityFooter, ...trailingFooter];
    return [lines[anchorIndex] ?? footer.at(-1) ?? "", ...visibleFooter].join("\n");
  }

  const bodyHeight = frameHeight - footer.length;
  const firstBodyRow = Math.max(
    0,
    Math.min(anchorIndex - bodyHeight + 1, lines.length - bodyHeight),
  );
  const body = lines.slice(firstBodyRow, firstBodyRow + bodyHeight);
  while (body.length < bodyHeight) body.push("");
  return [...body, ...footer].join("\n");
}
