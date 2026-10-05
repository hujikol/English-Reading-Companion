import { describe, expect, it } from "vitest";
import { joinTextItems, pageTextOf, type TextItemLike } from "../../../src/ui/reader/pageText.ts";

/**
 * Regression, from a real report: a page read as "oppor tunities".
 *
 * PDF.js emits one item per text-showing operator, not per word. The old code
 * did items.join(" "), which put a space at every item boundary — including the
 * ones INSIDE a single word. That broken string then reached the sentence shown
 * to the learner, the anchor's prefix/suffix, and every later re-anchor of a
 * mark.
 */

/** Item at x, on line y, `size` tall, `str` wide. */
const item = (str: string, x: number, y: number, size = 12, width?: number): TextItemLike => ({
  str,
  // [a,b,c,d,e,f] with e=x, f=y and a=d=size
  transform: [size, 0, 0, size, x, y],
  width: width ?? str.length * size * 0.5,
});

describe("joinTextItems: no spaces inside words", () => {
  it("joins a word split across two items with no space", () => {
    // "oppor" ends at x=30, "tunities" begins at 30 — a continuation.
    const items = [item("oppor", 0, 100, 12, 30), item("tunities", 30, 100, 12, 40)];
    expect(joinTextItems(items)).toBe("opportunities");
  });

  it("still separates genuinely separate words", () => {
    const items = [item("the", 0, 100, 12, 18), item("ferry", 24, 100, 12, 30)];
    expect(joinTextItems(items)).toBe("the ferry");
  });

  it("treats a new line as a space, not a line break", () => {
    const items = [item("first line", 0, 100, 12, 50), item("second line", 0, 84, 12, 60)];
    expect(joinTextItems(items)).toBe("first line second line");
  });

  it("handles a kerned pair with a negative gap", () => {
    const items = [item("AV", 0, 100, 12, 16), item("ery", 15, 100, 12, 20)];
    expect(joinTextItems(items)).toBe("AVery");
  });

  it("collapses a three-way split", () => {
    const items = [item("op", 0, 100, 12, 12), item("por", 12, 100, 12, 18), item("tunity", 30, 100, 12, 30)];
    expect(joinTextItems(items)).toBe("opportunity");
  });

  it("does not invent a space where the item already ends with one", () => {
    const items = [item("word ", 0, 100, 12, 26), item("next", 26, 100, 12, 24)];
    expect(joinTextItems(items)).toBe("word next");
  });

  it("returns an empty string for no usable items", () => {
    expect(joinTextItems([])).toBe("");
    expect(pageTextOf([{ notAString: 1 }])).toBe("");
  });
});

describe("pageTextOf", () => {
  it("keeps positioned text and ignores items with no position", () => {
    const items = [
      item("water", 0, 100, 12, 30),
      { str: "is" },          // no transform: no position, so spacing is unknowable
      { broken: true },
      item("wet", 60, 100, 12, 18),
    ];
    expect(pageTextOf(items)).toBe("water wet");
  });

  it("never leaves a double space behind", () => {
    const items = [item("a  ", 0, 100, 12, 14), item("b", 14, 100, 12, 8)];
    expect(pageTextOf(items)).not.toMatch(/ {2}/);
  });
});