import { describe, expect, it } from "vitest";
import {
  CONTEXT_CHARS,
  captureAnchor,
  cleanPageFraction,
  contextAround,
  disambiguate,
  findMatches,
  originalSlice,
  isLost,
  normalize,
  pageFractionOf,
  reanchor,
} from "../../src/features/selection/anchor.ts";

describe("normalization for matching only", () => {
  it("collapses whitespace runs and trims", () => {
    expect(normalize("  a   b \n c  ").text).toBe("a b c");
  });

  it("folds every apostrophe variant to one character", () => {
    const forms = ["don't", "don’t", "don‘ t".replace(" ", ""), "donʼt"];
    for (const f of forms) expect(normalize(f).text).toBe("don't");
  });

  it("expands ligatures", () => {
    expect(normalize("eﬃcient ﬁn").text).toBe("efficient fin");
  });

  it("lowercases and normalizes dashes", () => {
    expect(normalize("The—Dog –gone").text).toBe("the-dog -gone");
  });

  it("preserves a real intra-word hyphen and drops a soft hyphen", () => {
    expect(normalize("well-known").text).toBe("well-known");
    expect(normalize("well\u00ADknown").text).toBe("wellknown");
  });

  it("keeps the original length so end offsets map", () => {
    const src = "a  b";
    const n = normalize(src);
    expect(n.originalLength).toBe(src.length);
    expect(n.offsets).toHaveLength(n.text.length + 1);
    expect(n.offsets[n.text.length]).toBe(src.length);
  });

  it("maps a match back to original offsets across collapsed whitespace", () => {
    const page = "The   quick\n\nbrown fox";
    const m = findMatches(normalize(page), normalize("quick brown"))[0]!;
    expect(originalSlice(page, m)).toBe("quick\n\nbrown");
  });
});

describe("match finding and disambiguation", () => {
  it("returns every occurrence of a repeated phrase", () => {
    const page = "he said go. then he said go.";
    expect(findMatches(normalize(page), normalize("he said go"))).toHaveLength(2);
  });

  it("accepts a unique match without context", () => {
    expect(disambiguate("a needle in text", "needle")?.start).toBeGreaterThan(0);
  });

  it("abstains on an ambiguous match with no context", () => {
    expect(disambiguate("go home, go work", "go")).toBeUndefined();
  });

  it("resolves an ambiguous match using prefix and suffix", () => {
    const page = "alpha go home, beta go work";
    const want = page.indexOf("go work");
    expect(disambiguate(page, "go", "beta", "work")?.originalStart).toBe(want);
  });

  it("still abstains when both candidates agree with the context", () => {
    expect(disambiguate("go one, go two", "go", "go", "")).toBeUndefined();
  });

  it("reports no match rather than guessing", () => {
    expect(disambiguate("nothing here", "absent")).toBeUndefined();
    expect(findMatches(normalize("x"), normalize(""))).toEqual([]);
  });

  it("takes about 60 chars of context on each side", () => {
    const page = "p".repeat(500) + "MATCH" + "s".repeat(500);
    const c = contextAround(page, 500, 505);
    expect(c.prefix).toHaveLength(CONTEXT_CHARS);
    expect(c.suffix).toHaveLength(CONTEXT_CHARS);
  });
});

describe("captureAnchor", () => {
  const pageText = "Once upon a time in a land far away, the reader met a stranger.";
  const READER_AT = pageText.indexOf("reader");

  it("keeps the original selected text and adds context", () => {
    const a = captureAnchor({ selectedText: "reader", pageIndex: 2, pageFraction: 0.4, pageText, startInPage: READER_AT });
    expect(a.quote).toBe("reader");
    expect(a.prefix).toBe("Once upon a time in a land far away, the ");
    expect(pageText.slice(READER_AT - (a.prefix?.length ?? 0), READER_AT + 6)).toBe(`${a.prefix}reader`);
    expect(a.suffix).toBe(" met a stranger.");
    expect(a.locator).toEqual({ kind: "pdf", pageIndex: 2, pageFraction: 0.4 });
    expect(a.anchorState).toBe("resolved");
  });

  it("stores a position, never a box", () => {
    const a = captureAnchor({ selectedText: "reader", pageIndex: 2, pageFraction: 0.4, pageText, startInPage: READER_AT });
    expect(JSON.stringify(a)).not.toMatch(/bbox|rect|coord|top|left/i);
  });

  it("resolves the offset itself when not supplied", () => {
    expect(captureAnchor({ selectedText: "stranger", pageIndex: 0, pageFraction: 0, pageText }).anchorState).toBe("resolved");
  });

  it("stays unresolved when the quote is not on the page", () => {
    const a = captureAnchor({ selectedText: "not here", pageIndex: 1, pageFraction: 0.5, pageText });
    expect(a.anchorState).toBe("unresolved");
    expect(a.prefix).toBeUndefined();
  });

  it("stays unresolved without page text and records no context", () => {
    const a = captureAnchor({ selectedText: "reader", pageIndex: 1, pageFraction: 0.2 });
    expect(a).toMatchObject({ anchorState: "unresolved", quote: "reader" });
    expect(a.prefix).toBeUndefined();
    expect(a.suffix).toBeUndefined();
  });

  it("clamps and rounds an out-of-range pageFraction", () => {
    expect(captureAnchor({ selectedText: "x", pageIndex: 0, pageFraction: 3 }).locator).toMatchObject({ pageFraction: 1 });
    expect(captureAnchor({ selectedText: "x", pageIndex: 0, pageFraction: -1 }).locator).toMatchObject({ pageFraction: 0 });
    expect(cleanPageFraction(0.12345678)).toBe(0.123457);
    expect(cleanPageFraction(Number.NaN)).toBe(0);
  });

  it("computes a page fraction from a scroll offset", () => {
    expect(pageFractionOf(250, 1000)).toBe(0.25);
    expect(pageFractionOf(5000, 1000)).toBe(1);
    expect(pageFractionOf(10, 0)).toBe(0);
  });
});

describe("re-anchoring", () => {
  it("finds the quote again and records a resolution time", () => {
    const a = captureAnchor({ selectedText: "reader", pageIndex: 2, pageFraction: 0.4, pageText: "a b reader c" });
    const r = reanchor(a, "a b reader c", 500);
    if (r.anchorState !== "resolved") throw new Error(`expected resolved, got ${r.anchorState}`);
    expect(r.resolvedAt).toBe(500);
    expect(r.locator).toMatchObject({ kind: "pdf", pageIndex: 2 });
  });

  it("reports unresolved without moving the stored position", () => {
    const a = captureAnchor({ selectedText: "reader", pageIndex: 2, pageFraction: 0.4, pageText: "a reader b" });
    const r = reanchor(a, "completely different text", 500);
    expect(r.anchorState).toBe("unresolved");
    expect(r.locator).toEqual(a.locator);
  });

  it("matches through ligature and whitespace differences", () => {
    const a = captureAnchor({ selectedText: "efficient", pageIndex: 0, pageFraction: 0, pageText: "an eﬃcient  method" });
    expect(reanchor(a, "an efficient method").anchorState).toBe("resolved");
  });

  it("calls a quote lost when it appears on no page", () => {
    expect(isLost("reader", ["a", "b"])).toBe(true);
    expect(isLost("reader", ["the reader waved"])).toBe(false);
  });

  it("leaves a non-pdf anchor unresolved rather than guessing", () => {
    const a = captureAnchor({ selectedText: "x", pageIndex: 0, pageFraction: 0 });
    const other = { ...a, locator: { kind: "text" as const, blockId: "b", start: 0, end: 1 } };
    expect(reanchor(other, "x").anchorState).toBe("unresolved");
  });
});