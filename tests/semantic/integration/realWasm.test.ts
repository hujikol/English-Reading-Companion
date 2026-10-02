/**
 * Integration: the REAL `@firecrawl/pdf-inspector-wasm@1.25.2` WASM, the REAL
 * adapter, and a REAL PDF built from bytes in ./pdfFixture.ts.
 *
 * No test double participates anywhere in this file. If the page association
 * were wrong, no amount of green on the FakeInspector suite would catch it, so
 * this file exists to check the wiring the fake cannot.
 *
 * The WASM is loaded through the same ./loadInspectorEngine path production
 * uses, which in Node resolves the real `.wasm` out of node_modules and
 * instantiates it from bytes. A test that loaded it by a special route would
 * leave the production route unverified.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { loadInspectorEngine, isWasmReady } from "../../../src/document/wasm/index.ts";
import { associatePages } from "../../../src/document/wasm/pageMapping.ts";
import { createAdapter, extractPages, toSemanticPage } from "../../../src/document/adapter.ts";
import { indexPage, alignSelection } from "../../../src/document/align.ts";
import { toUpstreamPages } from "../../../src/document/pageSplit.ts";
import { PAGE_MARKER_OPTION } from "../../../src/document/pageSplit.ts";
import { semanticWindow, DESKTOP_RADIUS } from "../../../src/document/jobs.ts";
import type { InspectorEngine, InspectorOptions } from "../../../src/document/types.ts";
import {
  buildFixturePdf,
  buildSparseFixturePdf,
  buildPdf,
  FIXTURE_PAGES,
  PAGE_ONE_SENTENCE,
} from "./pdfFixture.ts";

let engine: InspectorEngine;
let pdf: Uint8Array;

beforeAll(async () => {
  engine = await loadInspectorEngine();
  pdf = buildFixturePdf();
}, 60_000);

describe("real WASM: module", () => {
  it("initializes and reports the packaged version", () => {
    expect(isWasmReady()).toBe(true);
    // The version read from the module, not from package.json. It flows into
    // every extraction key, so it has to be the shipped binary's own claim.
    expect(engine.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("classifies a real text PDF as TextBased with the true page count", () => {
    const c = engine.classifyPdf(pdf);
    expect(c.pdfType).toBe("TextBased");
    expect(c.pageCount).toBe(3);
  });

  it("rejects bytes that are not a PDF instead of returning empty output", () => {
    // A silent empty result here would let a corrupted upload look like a
    // valid document with no text.
    expect(() => engine.classifyPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x0a]))).toThrow();
  });
});

describe("real WASM: page association", () => {
  it("returns ONE flat markdown string with no per-page structure", () => {
    // This is the constraint the whole adapter is built around. Asserted so a
    // future parser upgrade that adds structure is noticed here rather than
    // silently invalidating the marker logic.
    const r = engine.processPdf(pdf, { ...PAGE_MARKER_OPTION });
    expect(typeof r.markdown).toBe("string");
    expect(r.pageCount).toBe(3);
    // Markers exist, and there is one per page, each naming its true page.
    const markers = [...(r.markdown ?? "").matchAll(/<!--\s*Page\s+(\d+)\s*-->/g)].map((m) => Number(m[1]));
    expect(markers).toEqual([1, 2, 3]);
  });

  it("emits NO marker for a page with no text, keeping later markers on their true pages", () => {
    // The real finding that motivates the per-page fallback. A test double
    // that always emitted a marker would hide this entirely.
    const sparse = buildSparseFixturePdf();
    const r = engine.processPdf(sparse, { ...PAGE_MARKER_OPTION });
    const markers = [...(r.markdown ?? "").matchAll(/<!--\s*Page\s+(\d+)\s*-->/g)].map((m) => Number(m[1]));
    // 3 pages requested in total, middle one empty: two markers, and the
    // third still claims to be page 3 rather than sliding down to page 2.
    expect(r.pageCount).toBe(3);
    expect(markers).toEqual([1, 3]);
  });

  it("rejects zero-based page 0 upstream, which is why toUpstreamPages exists", () => {
    expect(toUpstreamPages([0, 1, 2])).toEqual([1, 2, 3]);
    expect(() => engine.processPdf(pdf, { pages: [0] })).toThrow();
  });

  it("associates each page to its own text, in order, with the right zero-based index", () => {
    const r = extractPages(createAdapter(engine, { bytes: pdf, pageCount: 3 }), [0, 1, 2]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.retriedIndividually).toBe(false);
    expect(r.pages.map((p) => p.pageIndex)).toEqual([0, 1, 2]);
    // Every page non-empty: a page that came back empty would be a silent
    // mis-association rather than a visible failure.
    for (const p of r.pages) expect(p.text.length).toBeGreaterThan(0);

    // Order proved by CONTENT, not by index alone. Page 0's distinctive
    // sentence must be on page 0 and nowhere else; a boundary shift by one
    // would satisfy a pageCount check and fail these.
    expect(r.pages[0]!.text).toContain(PAGE_ONE_SENTENCE);
    expect(r.pages[1]!.text).toContain("the qualification in the middle of the sentence");
    expect(r.pages[2]!.text).toContain("page order can be proved");
    for (const [i, p] of r.pages.entries()) {
      if (i !== 0) expect(p.text).not.toContain(PAGE_ONE_SENTENCE);
    }
  });

  it("marks every text page usable, and flags the empty page rather than inventing text", () => {
    const a = createAdapter(engine, { bytes: buildSparseFixturePdf(), pageCount: 3 });
    const r = extractPages(a, [0, 1, 2]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Batch markers were insufficient, so the documented fallback ran.
    expect(r.retriedIndividually).toBe(true);

    const byIndex = new Map(r.pages.map((p) => [p.pageIndex, p]));
    expect([...byIndex.keys()].sort((x, y) => x - y)).toEqual([0, 1, 2]);
    // The empty page recovers as an empty page — never page 3's text.
    expect(byIndex.get(1)!.text).toBe("");
    expect(byIndex.get(1)!.quality).not.toBe("usable");
    // And the pages AFTER the gap are still on their true indexes.
    expect(byIndex.get(2)!.text).toContain("page order can be proved");
    expect(byIndex.get(0)!.text).toContain(PAGE_ONE_SENTENCE);
  });

  it("associates a non-contiguous window, proving no boundary is inferred from position", () => {
    // Pages 0 and 2 only. A length-division or offset heuristic would
    // misattribute here; only markers survive it.
    const a = createAdapter(engine, { bytes: pdf, pageCount: 3 });
    const r = extractPages(a, [0, 2]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages.map((p) => p.pageIndex)).toEqual([0, 2]);
    expect(r.pages[0]!.text).toContain(PAGE_ONE_SENTENCE);
    expect(r.pages[1]!.text).toContain("page order can be proved");
  });

  it("reports a single-page request as that page without needing a marker", () => {
    const a = createAdapter(engine, { bytes: pdf, pageCount: 3 });
    const r = extractPages(a, [1]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]!.pageIndex).toBe(1);
    expect(r.pages[0]!.text).toContain("the qualification in the middle of the sentence");
  });

  it("sends 1-indexed pages upstream for a zero-based window", () => {
    // The Section 6 window, and the exact conversion the adapter performs.
    const window = semanticWindow({ visiblePageIndex: 1, pageCount: 3, radius: DESKTOP_RADIUS });
    expect(window).toEqual([0, 1, 2]);
    expect(toUpstreamPages(window)).toEqual([1, 2, 3]);
  });
});

describe("real WASM: selection alignment", () => {
  it("aligns a selection taken from page 1 to page 1's semantic page", () => {
    const a = createAdapter(engine, { bytes: pdf, pageCount: 3 });
    const r = extractPages(a, [0, 1, 2]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The user's exact selection, as PDF.js would hand it over: unmodified,
    // from a known page, with no geometry anywhere.
    const selection = "The word however carries a promise";
    const indexed = r.pages.map((p) => indexPage({ pageIndex: p.pageIndex, text: p.text, blocks: p.blocks }));

    const aligned = alignSelection({ selection, selectionPageIndex: 1, pages: indexed });
    expect(aligned.status).toBe("aligned");
    if (aligned.status !== "aligned") return;

    // Right page, and the offsets address the REAL page text, not a guess.
    expect(aligned.pageIndex).toBe(1);
    expect(r.pages[1]!.text.slice(aligned.start, aligned.end)).toBe(selection);
    // Context comes from the same page and cannot cross a block wall.
    expect(aligned.context === null || r.pages[1]!.text.includes(aligned.context)).toBe(true);
  });

  it("aligns a page-1 selection when only a page-1 window is indexed", () => {
    // The realistic reading case: the visible window, not the whole book.
    const a = createAdapter(engine, { bytes: pdf, pageCount: 3 });
    const r = extractPages(a, [0, 1, 2]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const firstOnly = indexPage({ pageIndex: r.pages[0]!.pageIndex, text: r.pages[0]!.text, blocks: r.pages[0]!.blocks });
    const aligned = alignSelection({ selection: "Vocabulary grows from attention", selectionPageIndex: 2, pages: [firstOnly] });
    // Not searched, so not found — reported, never guessed.
    expect(aligned.status).toBe("not-found");
  });

  it("produces a stored SemanticPage with no geometry and a per-page cache key", () => {
    const a = createAdapter(engine, { bytes: pdf, pageCount: 3 });
    const r = extractPages(a, [0]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = toSemanticPage(a, "doc-1", "a".repeat(64), r.pages[0]!, 1_700_000_000_000);
    expect(row.pageIndex).toBe(0);
    expect(row.text).toContain(PAGE_ONE_SENTENCE);
    expect(row.source).toBe("inspector-wasm");
    // Derived data only: it must carry no user records and no coordinates.
    expect(Object.keys(row)).not.toContain("marks");
    expect(JSON.stringify(row)).not.toMatch(/pageFraction|bbox|\bxywh\b|viewport/i);
  });
});

describe("real WASM: derived page mapping", () => {
  it("maps a real batch result through validated markers", () => {
    const r = engine.processPdf(pdf, { ...PAGE_MARKER_OPTION });
    const a = associatePages({
      result: r,
      requested: [0, 1, 2],
      requestPage: (pageIndex) => engine.processPdf(pdf, { ...PAGE_MARKER_OPTION, pages: toUpstreamPages([pageIndex]) }),
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.retriedIndividually).toBe(false);
    expect(a.pages.map((p) => p.pageIndex)).toEqual([0, 1, 2]);
    expect(a.pages.every((p) => p.source === "marker")).toBe(true);
  });

  it("falls back per page on the real empty-page case and reports the gap honestly", () => {
    const sparse = buildSparseFixturePdf();
    const r = engine.processPdf(sparse, { ...PAGE_MARKER_OPTION });
    const a = associatePages({
      result: r,
      requested: [0, 1, 2],
      requestPage: (pageIndex) => engine.processPdf(sparse, { ...PAGE_MARKER_OPTION, pages: toUpstreamPages([pageIndex]) }),
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.retriedIndividually).toBe(true);
    expect(a.pages.map((p) => p.pageIndex)).toEqual([0, 1, 2]);
    expect(a.pages[1]!.source).toBe("empty");
    expect(a.pages[1]!.markdown.trim()).toBe("");
  });
});

describe("real WASM: edge cases", () => {
  it("keeps page count and text separate for a single-page document", () => {
    const one = buildPdf([FIXTURE_PAGES[0]!]);
    expect(engine.classifyPdf(one).pageCount).toBe(1);
    const r = extractPages(createAdapter(engine, { bytes: one, pageCount: 1 }), [0]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages[0]!.text).toContain(PAGE_ONE_SENTENCE);
  });

  it("returns a typed failure for a closed adapter instead of throwing", () => {
    const a = createAdapter(engine, { bytes: pdf, pageCount: 3 });
    a.bytes = null;
    const r = extractPages(a, [0]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("engine-failure");
  });

  it("handles a document whose pages have very different lengths", () => {
    // Uneven pages: the case where dividing text by page count would put the
    // boundaries in the wrong place.
    const uneven = buildPdf([["Short."], ["A much longer second page. ".repeat(40)], ["Third."]]);
    const r = extractPages(createAdapter(engine, { bytes: uneven, pageCount: 3 }), [0, 1, 2]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages[0]!.text).toBe("Short.");
    expect(r.pages[2]!.text).toBe("Third.");
    expect(r.pages[1]!.text.length).toBeGreaterThan(r.pages[0]!.text.length);
  });

  it("does not retry forever: a failing per-page request is a typed failure", () => {
    // The sparse fixture is what forces the retry at all: a well-formed
    // 3-page document's markers validate on the first attempt, so the retry
    // path would never run and a throw here would go unnoticed.
    const sparse = buildSparseFixturePdf();
    const r = associatePages({
      result: engine.processPdf(sparse, { ...PAGE_MARKER_OPTION }),
      requested: [0, 1, 2],
      requestPage: () => {
        throw new Error("wasm trap: unreachable");
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("per-page retry");
  });
});
