import { describe, expect, it } from "vitest";
import { buildSelection, sentenceAround } from "../../../src/ui/reader/popoverBridge.ts";
import type { SelectionCapture } from "../../../src/ui/reader/selection.ts";

const PAGE = "The committee decided that leverage of existing infrastructure would compound over time. Everyone agreed.";

const capture = (over: Partial<SelectionCapture> = {}): SelectionCapture => ({
  quote: "leverage",
  startInPage: PAGE.indexOf("leverage"),
  viewportRect: { top: 100, left: 40, width: 90, height: 18 },
  ...over,
});

const input = (over: Partial<Parameters<typeof buildSelection>[0]> = {}) => ({
  capture: capture(),
  pageIndex: 0,
  pageFraction: 0,
  pageText: PAGE,
  documentId: "doc1",
  titleSnapshot: "A Book",
  ...over,
});

describe("popoverBridge: the join that was missing", () => {
  it("turns a reader capture into a popover selection", () => {
    const sel = buildSelection(input());
    expect(sel).toBeDefined();
    expect(sel?.surface).toBe("leverage");
    expect(sel?.documentId).toBe("doc1");
    expect(sel?.titleSnapshot).toBe("A Book");
    expect(sel?.positionLabel).toBe("Page 1");
  });

  it("produces a durable Anchor carrying the quote and context", () => {
    const sel = buildSelection(input());
    // The whole point of the anchor: re-findable text, not geometry.
    expect(sel?.anchor.quote).toBe("leverage");
    expect(sel?.anchor.anchorState).toBe("resolved");
    expect(sel?.anchor.locator.kind).toBe("pdf");
  });

  it("keeps geometry OUT of the anchor", () => {
    const sel = buildSelection(input());
    const serialized = JSON.stringify(sel?.anchor);
    expect(serialized).not.toMatch(/viewportRect|bbox|top|left|width|height/i);
  });

  it("carries the sentence as provenance", () => {
    const sel = buildSelection(input());
    expect(sel?.sentence).toContain("leverage");
    expect(sel?.sentence.length).toBeLessThan(PAGE.length);
  });

  it("abstains on a whitespace-only selection rather than opening a card", () => {
    expect(buildSelection(input({ capture: capture({ quote: "   " }) }))).toBeUndefined();
  });

  it("abstains when there is no rect, because the card has nowhere to sit", () => {
    expect(buildSelection(input({ capture: capture({ viewportRect: undefined }) }))).toBeUndefined();
  });

  it("trims the selection before using it as the lookup surface", () => {
    const sel = buildSelection(input({ capture: capture({ quote: "  leverage  " }) }));
    expect(sel?.surface).toBe("leverage");
  });
});

describe("sentenceAround", () => {
  it("cuts at the first sentence end after the quote", () => {
    expect(sentenceAround(PAGE, PAGE.indexOf("leverage"), "leverage")).toBe(
      "The committee decided that leverage of existing infrastructure would compound over time.",
    );
  });

  it("returns the quote when there is no page text", () => {
    expect(sentenceAround("", 0, "leverage")).toBe("leverage");
  });

  it("never throws on an out-of-range offset", () => {
    expect(() => sentenceAround(PAGE, 99999, "x")).not.toThrow();
  });

  it("collapses whitespace so the sentence reads as one line", () => {
    expect(sentenceAround("a\n\n  b   c.", 0, "a")).not.toMatch(/\n/);
  });
});
