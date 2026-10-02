import { describe, expect, it } from "vitest";
import { stackState, visiblePageOfState, pageFractionAtState } from "../../../src/ui/reader/readerModel.ts";

const geometry = { pageCount: 500, pageHeight: 800, gap: 16, padding: 16 };

describe("stackState: the whole document has geometry, not just mounted pages", () => {
  it("gives every page a top, including pages outside any render window", () => {
    const state = stackState(geometry, 0);
    expect(state.tops.size).toBe(500);
    expect(state.heights.size).toBe(500);
    // This is the regression: only mounted pages used to have a top, so the
    // reader could never scroll past the render window.
    expect(state.tops.get(499)).toBe(16 + 499 * 816);
  });

  it("spaces pages by height + gap, offset by the container padding", () => {
    const state = stackState(geometry, 0);
    expect(state.tops.get(0)).toBe(16);
    expect(state.tops.get(1)).toBe(16 + 816);
  });

  it("resolves the visible page far beyond the mounted window", () => {
    const scrollTop = 16 + 300 * 816;
    expect(visiblePageOfState(stackState(geometry, scrollTop))).toBe(300);
  });

  it("resolves page 0 when scrolled above the first page", () => {
    expect(visiblePageOfState(stackState(geometry, 0))).toBe(0);
    expect(visiblePageOfState(stackState(geometry, -50))).toBe(0);
  });

  it("reports the fraction scrolled into a page, clamped to 0..1", () => {
    const state = stackState(geometry, 16 + 10 * 816 + 400);
    const fraction = pageFractionAtState(state, 10);
    expect(fraction).toBeCloseTo(400 / 800, 5);
  });

  it("is empty for a document with no pages", () => {
    const state = stackState({ ...geometry, pageCount: 0 }, 0);
    expect(state.tops.size).toBe(0);
    expect(visiblePageOfState(state)).toBe(0);
  });
});
