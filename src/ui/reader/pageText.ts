/**
 * Reconstruct page text from PDF.js text items.
 *
 * PDF.js emits one item per text-showing operator, not per word. A single word
 * is often split across two or more items — justified text, kerning pairs,
 * ligature decomposition, and subset fonts all do this. Joining items with a
 * space therefore injects spaces INSIDE words: "opportunities" is read as
 * "oppor tunities", which then reaches the sentence shown to the learner, the
 * anchor context, and every later re-anchor of a mark.
 *
 * So the space is decided by geometry, not by item boundaries: items on the same
 * line with no meaningful horizontal gap are joined with nothing, and a gap
 * wider than a fraction of the font size becomes a space. A new line becomes a
 * single space, because callers want flowing text, not layout.
 */

/** The subset of a PDF.js text item this module needs. */
export type TextItemLike = {
  str: string;
  /** [a, b, c, d, e, f]; e and f are the x/y position on the page. */
  transform: number[];
  /** advance width of this item in text-space units */
  width: number;
  hasEOL?: boolean;
  fontName?: string;
};

/** A gap wider than this multiple of the font size is treated as a space. */
const SPACE_GAP_RATIO = 0.2;
/** Below this the two items are the same line for our purposes. */
const SAME_LINE_EPSILON = 2;

/** Approximate font size from the text matrix: the y scale of the transform. */
const sizeOf = (item: TextItemLike): number => {
  const t = item.transform;
  const a = t[0] ?? 1;
  const b = t[1] ?? 0;
  const c = t[2] ?? 0;
  const d = t[3] ?? 1;
  return Math.max(1, Math.hypot(b, d) || Math.hypot(a, c) || 1);
};

/**
 * Join items into one line of text.
 *
 * Exported for testing: the geometry rules are the whole substance here, and a
 * naive `join(" ")` is exactly the bug this replaces.
 */
export function joinTextItems(items: readonly TextItemLike[]): string {
  let out = "";
  let previousEnd: number | null = null;
  let previousY: number | null = null;
  let previousSize = 10;

  for (const item of items) {
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    const size = sizeOf(item);

    if (previousEnd !== null && previousY !== null) {
      const sameLine = Math.abs(y - previousY) <= SAME_LINE_EPSILON;
      if (!sameLine) {
        out += " ";
      } else {
        const gap = x - previousEnd;
        // A negative or tiny gap means the next item continues the current word:
        // kerning, a split subset font, or a trailing space already in `str`.
        if (gap > SPACE_GAP_RATIO * Math.min(size, previousSize)) out += " ";
      }
    }

    out += item.str;
    previousEnd = x + item.width;
    previousY = y;
    previousSize = size;
  }

  return out.replace(/[ \t]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Page text, ready for anchors, sentences and marks. */
export function pageTextOf(items: readonly unknown[]): string {
  const usable = items.filter(
    (i): i is TextItemLike =>
      typeof i === "object" &&
      i !== null &&
      typeof (i as { str?: unknown }).str === "string" &&
      // A text item without a transform has no position, so spacing cannot be
      // decided. Filtered rather than defaulted: treating it as x=0 would merge
      // it onto the previous line or separate it with a fabricated space.
      Array.isArray((i as { transform?: unknown }).transform),
  );
  return joinTextItems(usable);
}