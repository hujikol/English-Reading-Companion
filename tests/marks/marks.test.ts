import { describe, expect, it } from "vitest";
import { buildPageIndex, liveMarks, markOverlaps, reanchor, reanchorAll } from "../../src/features/marks/service.ts";
import type { AnchorTarget } from "../../src/features/marks/service.ts";
import { indexPage } from "../../src/document/align.ts";
import { normalizeMarkdown } from "../../src/document/normalizer.ts";
import { saveMark } from "../../src/features/marks/save.ts";
import type { Mark } from "../../src/contracts/index.ts";

const page = (pageIndex: number, md: string): AnchorTarget => {
  const p = normalizeMarkdown(md);
  return indexPage({ pageIndex, text: p.text, blocks: p.blocks });
};

const mark = (over: Partial<Mark> = {}): Mark => ({
  id: "m1",
  documentId: "doc-1",
  titleSnapshot: "Chapter 1",
  anchor: {
    quote: "dog barked",
    locator: { kind: "pdf", pageIndex: 0, pageFraction: 0.5 },
    anchorState: "resolved",
    prefix: "A",
    suffix: " loudly",
  },
  color: "yellow",
  createdAt: 0,
  ...over,
});

describe("saveMark", () => {
  it("stores the exact quote and logical locator, and no viewport rectangle", () => {
    const r = saveMark({
      id: "m1",
      documentId: "doc-1",
      titleSnapshot: "Chapter 1",
      quote: "  dog barked  ",
      prefix: "A ",
      suffix: " loudly",
      locator: { kind: "pdf", pageIndex: 4, pageFraction: 0.25 },
      color: "yellow",
      now: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mark.anchor.quote).toBe("dog barked");
    // Nothing has re-found the quote in extraction output yet, so the new anchor
    // is unresolved. Claiming "resolved" here is an unverified confidence.
    expect(r.mark.anchor.anchorState).toBe("unresolved");
    expect(r.mark.anchor.resolvedAt).toBeUndefined();
    expect(r.mark.createdAt).toBe(5);
    expect(JSON.stringify(r.mark)).not.toMatch(/bbox|rect|coordinateSpace/);
  });

  it("refuses an empty quote, a missing locator and a bad page index", () => {
    const base = { id: "m1", documentId: "doc-1", titleSnapshot: "t", color: "yellow" as const, now: 0 };
    expect(saveMark({ ...base, quote: "   ", locator: { kind: "pdf", pageIndex: 0, pageFraction: 0.5 } })).toMatchObject({
      ok: false,
      reason: "empty-quote",
    });
    expect(saveMark({ ...base, quote: "x" })).toMatchObject({ ok: false, reason: "missing-format-locator" });
    expect(saveMark({ ...base, quote: "x", locator: { kind: "pdf", pageIndex: -1, pageFraction: 0.5 } })).toMatchObject({
      ok: false,
      reason: "bad-page-index",
    });
  });
});

describe("reanchoring", () => {
  const index = buildPageIndex([page(0, "The cat sat. A dog barked loudly. Then it slept.")]);

  it("resolves a mark whose quote is present once", () => {
    const out = reanchor(mark(), index, 99);
    expect(out.anchorState).toBe("resolved");
    if (out.anchorState !== "resolved") return;
    expect(out.span.start).toBeGreaterThan(0);
    expect(out.span.context).toContain("dog barked");
    expect(out.anchor.resolvedAt).toBe(99);
  });

  it("reports lost, not silently unresolved, when the text is gone", () => {
    const out = reanchor(mark({ anchor: { ...mark().anchor, quote: "a sentence nobody wrote" } }), index, 1);
    expect(out.anchorState).toBe("lost");
    expect(out.anchor.anchorState).toBe("lost");
  });

  it("reports lost for an empty quote", () => {
    const out = reanchor(mark({ anchor: { quote: "  ", locator: { kind: "pdf", pageIndex: 0, pageFraction: 0.5 }, anchorState: "resolved" } }), index, 1);
    expect(out).toMatchObject({ anchorState: "lost", reason: "empty-quote" });
  });

  it("reports unresolved when the text exists more than once", () => {
    const dup = buildPageIndex([page(0, "A dog barked. Then a dog barked again.")]);
    const out = reanchor(mark({ anchor: { quote: "dog barked", locator: { kind: "pdf", pageIndex: 0, pageFraction: 0.5 }, anchorState: "resolved" } }), dup, 1);
    expect(out.anchorState).toBe("unresolved");
  });

  it("rewrites a previously resolved anchor that no longer matches", () => {
    const empty = buildPageIndex([page(0, "")]);
    const out = reanchor(mark(), empty, 1);
    expect(out.anchor.anchorState).not.toBe("resolved");
  });

  it("follows the quote when the extraction re-flows it onto another page", () => {
    // The stored locator is a hint, not a filter. Reporting "lost" for text that
    // is still in the document is the silent failure section 7 forbids, so the
    // anchor is rewritten onto the page the text is actually on.
    const moved = buildPageIndex([page(0, "Some other page."), page(9, "A dog barked loudly.")]);
    const out = reanchor(mark({ anchor: { ...mark().anchor, locator: { kind: "pdf", pageIndex: 4, pageFraction: 0.1 } } }), moved, 1);
    expect(out.anchorState).toBe("resolved");
    if (out.anchorState !== "resolved") return;
    expect(out.span.pageIndex).toBe(9);
    expect(out.anchor.locator).toEqual({ kind: "pdf", pageIndex: 9, pageFraction: 0.1 });
  });

  it("reports lost only when the quote is gone from every indexed page", () => {
    const gone = buildPageIndex([page(9, "A dog barked loudly."), page(0, "Some other page.")]);
    expect(reanchor(mark(), gone, 1).anchorState).toBe("resolved");
    expect(reanchor(mark({ anchor: { ...mark().anchor, quote: "nowhere to be found" } }), gone, 1).anchorState).toBe("lost");
  });

  it("searches every indexed block for a reflowable locator", () => {
    // EPUB/TXT have no fixed page, so a text locator may land anywhere after a
    // re-render. Same alignment code, wider candidate set.
    const reanchored: Mark = {
      ...mark(),
      anchor: { quote: "dog barked", locator: { kind: "text", blockId: "b7", start: 0, end: 9 }, anchorState: "resolved" },
    };
    const out = reanchor(reanchored, buildPageIndex([page(0, "x"), page(9, "A dog barked loudly.")]), 1);
    expect(out.anchorState).toBe("resolved");
    if (out.anchorState !== "resolved") return;
    expect(out.span.pageIndex).toBe(9);
    // The locator's own fields are preserved; only pdf carries a page index.
    expect(out.anchor.locator).toEqual({ kind: "text", blockId: "b7", start: 0, end: 9 });
  });

  it("gives every mark a verdict", () => {
    const marks = [
      mark({ id: "ok" }),
      mark({
        id: "gone",
        anchor: { quote: "not in the page", locator: { kind: "pdf", pageIndex: 0, pageFraction: 0.5 }, anchorState: "lost" },
      }),
    ];
    const report = reanchorAll(marks, index, 7);
    expect(report.examined).toBe(2);
    expect(report.resolved.map((r) => r.mark.id)).toEqual(["ok"]);
    expect(report.lost.map((r) => r.mark.id)).toEqual(["gone"]);
  });
});

describe("dense page", () => {
  it("builds one index for many marks, and resolves each against it", () => {
    const sentences = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} sits here.`);
    const target = page(3, sentences.join(" "));
    const marks = Array.from({ length: 100 }, (_, i) =>
      mark({ id: `m${i}`, anchor: { quote: `number ${i} sits`, locator: { kind: "pdf", pageIndex: 3, pageFraction: 0.5 }, anchorState: "resolved" } }),
    );

    const index = buildPageIndex([target]);
    // One normalization pass for the page, reused by all 100 marks.
    expect(index.builtPages).toBe(1);

    const report = reanchorAll(marks, index, 1);
    expect(report.resolved).toHaveLength(100);
    expect(report.lost).toHaveLength(0);
    expect(report.unresolved).toHaveLength(0);

    // Every mark lands on its own sentence: no two spans overlap or repeat.
    const spans = report.resolved.map((r) => `${r.span.start}:${r.span.end}`).sort();
    expect(new Set(spans).size).toBe(100);
    for (const r of report.resolved) expect(target.text.slice(r.span.start, r.span.end)).toBe(r.mark.anchor.quote);
  });
});

describe("helpers", () => {
  it("excludes soft-deleted marks and other documents", () => {
    const all = [mark({ id: "a" }), mark({ id: "b", deletedAt: 5 }), mark({ id: "c", documentId: "doc-2" })];
    expect(liveMarks(all, "doc-1").map((m) => m.id)).toEqual(["a"]);
  });

  it("detects overlapping spans on the same page only", () => {
    const a = { pageIndex: 0, start: 0, end: 10, kind: "unique" as const, context: null };
    expect(markOverlaps(a, { ...a, start: 9, end: 12 })).toBe(true);
    expect(markOverlaps(a, { ...a, start: 10, end: 12 })).toBe(false);
    expect(markOverlaps(a, { ...a, pageIndex: 1 })).toBe(false);
  });
});
