/**
 * How many terminal cells a string prints.
 *
 * A terminal is a grid of cells, not of code points. `[...value].length` answers a different
 * question and disagrees with the grid in three ways that all land in the same place — the caret
 * ends up somewhere the operator's text is not:
 *
 * - an East Asian ideograph or an emoji occupies two cells,
 * - a combining mark occupies none, it decorates the cell before it,
 * - a grapheme built out of several code points (`é` as `e` + U+0301, a ZWJ family, a flag) is one
 *   cluster the terminal draws as one unit.
 *
 * Clusters come from `Intl.Segmenter`, so the multi-code-point cases are counted once rather than
 * once per code point. This is a measurement, not a validation: control bytes count zero because
 * they print nothing, and no input is rejected.
 */
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Code points the terminal draws two cells wide, by block rather than by table lookup. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // Kana, Hangul Compatibility Jamo, CJK compatibility
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f1e6, 0x1f1ff], // Regional indicators — a flag is a pair, and the pair is one cluster
  [0x20000, 0x3fffd], // CJK Unified Ideographs Extension B and beyond
];

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;

/** Splits a string into the units a terminal draws one at a time. */
export function graphemes(value: string): string[] {
  return [...GRAPHEME_SEGMENTER.segment(value)].map(({ segment }) => segment);
}

/** The cells one grapheme cluster prints. */
export function graphemeWidth(grapheme: string): number {
  const first = grapheme.codePointAt(0);
  if (first === undefined) return 0;
  // C0 and C1 controls print nothing. Anything that steers the terminal is not text here.
  if (first < 0x20 || (first >= 0x7f && first < 0xa0)) return 0;
  const head = String.fromCodePoint(first);
  if (ZERO_WIDTH.test(head)) return 0;
  // U+FE0F asks for the emoji presentation of a character that is otherwise drawn as text, and the
  // emoji presentation is two cells wide even when the bare code point is one.
  if (grapheme.includes("\u{FE0F}")) return 2;
  if (WIDE_RANGES.some(([low, high]) => first >= low && first <= high)) return 2;
  // A character whose default presentation is emoji draws two cells wherever it lives — ⌚ and ⌛
  // sit in the BMP but the terminal still gives them a double cell. Text-presentation pictographs
  // (arrows, dingbats) stay one cell unless U+FE0F said otherwise above.
  if (EMOJI_PRESENTATION.test(head)) return 2;
  if (first >= 0x1f000 && PICTOGRAPHIC.test(head)) return 2;
  return 1;
}

/** The cells a string prints, summed over its grapheme clusters. */
export function displayWidth(value: string): number {
  let total = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) total += graphemeWidth(segment);
  return total;
}
