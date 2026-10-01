import { describe, expect, it } from "vitest";
import { FakeInspector } from "../../src/document/fakeInspector.ts";
import type { FakeInspectorSpec } from "../../src/document/fakeInspector.ts";
import { adapterOptionsHash, closeAdapter, createAdapter, extractPages, toSemanticPage } from "../../src/document/adapter.ts";
import { extractionKey } from "../../src/document/cacheKey.ts";

const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

const adapter = (spec: FakeInspectorSpec, over: Partial<Parameters<typeof createAdapter>[1]> = {}) =>
  createAdapter(new FakeInspector(spec), { bytes: BYTES, pageCount: spec.pages.length, ...over });

const simple = (): FakeInspectorSpec => ({
  version: "1.25.2",
  pages: [{ markdown: "First page text." }, { markdown: "Second page text." }, { markdown: "Third page text." }],
});

describe("page association", () => {
  it("associates batch output with pages through validated markers", () => {
    const r = extractPages(adapter(simple()), [0, 1, 2]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.retriedIndividually).toBe(false);
    expect(r.pages.map((p) => [p.pageIndex, p.text])).toEqual([
      [0, "First page text."],
      [1, "Second page text."],
      [2, "Third page text."],
    ]);
  });

  it("retries one page at a time when the engine emits no markers", () => {
    const a = adapter({ ...simple(), suppressMarkers: true });
    const r = extractPages(a, [0, 1, 2]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.retriedIndividually).toBe(true);
    expect(r.pages.map((p) => p.text)).toEqual(["First page text.", "Second page text.", "Third page text."]);
  });

  it("never invents page boundaries from text length", () => {
    // Uneven pages: dividing the text by pageCount would put these in the wrong
    // place. Markers are the only source of the boundary.
    const a = adapter({
      pages: [{ markdown: "short" }, { markdown: "a considerably longer second page of body text" }],
    });
    const r = extractPages(a, [0, 1]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages[0]?.text).toBe("short");
    expect(r.pages[1]?.text).toBe("a considerably longer second page of body text");
  });

  it("rejects out-of-range and malformed page requests without calling the engine", () => {
    const a = adapter(simple());
    expect(extractPages(a, [-1]).ok).toBe(false);
    expect(extractPages(a, [1.5]).ok).toBe(false);
    expect(extractPages(a, [99]).ok).toBe(false);
    expect((a.engine as FakeInspector).calls).toHaveLength(0);
  });

  it("sends 1-indexed pages upstream and accepts them only as zero-based here", () => {
    const a = adapter(simple());
    extractPages(a, [0, 2]);
    expect((a.engine as FakeInspector).calls[0]?.pages).toEqual([1, 3]);
  });
});

describe("failure handling", () => {
  it("reports an encrypted document as password-required, not as a crash", () => {
    const r = extractPages(adapter({ ...simple(), throws: "Failed to open PDF: password required" }), [0]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("password-required");
    expect(r.message).toContain("password");
  });

  it("reports any other engine failure without throwing", () => {
    const r = extractPages(adapter({ ...simple(), throws: "wasm trap: unreachable" }), [0]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("engine-failure");
    expect(r.message).toContain("unreachable");
  });

  it("refuses to extract after CLOSE released the parser input", () => {
    const a = closeAdapter(adapter(simple()));
    const r = extractPages(a, [0]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("closed");
  });
});

describe("quality is judged per page, not from classification", () => {
  it("marks a scanned page as needing OCR even when classification calls the file text-based", () => {
    const r = extractPages(
      adapter({
        pages: [{ markdown: "", needsOcr: true, ocrReasons: ["no text layer"] }, { markdown: "Real text." }],
        pdfType: "TextBased",
      }),
      [0, 1],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages[0]?.quality).not.toBe("usable");
    expect(r.pages[0]?.needsOcr).toBe(true);
    // A single good page is unaffected by its neighbour's failure.
    expect(r.pages[1]?.quality).toBe("usable");
  });
});

describe("derived page rows", () => {
  it("keys a page by the full extraction identity and stores no geometry", () => {
    const a = adapter(simple());
    const r = extractPages(a, [0]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const page = toSemanticPage(a, "doc-1", "a".repeat(64), r.pages[0]!, 1_000);
    expect(page.cacheKey).toBe(
      extractionKey({
        contentHash: "a".repeat(64),
        parserEngine: page.parser,
        parserVersion: "1.25.2",
        optionsHash: adapterOptionsHash(a),
        normalizerVersion: page.normalizerVersion,
        pageIndex: 0,
      }),
    );
    expect(page.text).toBe("First page text.");
    expect(page.blocks.map((b) => [b.id, b.kind, b.start, b.end])).toEqual([["b0", "paragraph", 0, 16]]);

    // Nothing here may look like a positioned-text field.
    const serialized = JSON.stringify(page);
    for (const forbidden of ["bbox", "coordinateSpace", "rect", "transform", "x:", "y:"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("changes the key when the parser version changes, so derived pages are evicted", () => {
    const v1 = adapter({ ...simple(), version: "1.25.2" });
    const v2 = adapter({ ...simple(), version: "1.26.0" });
    const r1 = extractPages(v1, [0]);
    const r2 = extractPages(v2, [0]);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    const k1 = toSemanticPage(v1, "doc-1", "a".repeat(64), r1.pages[0]!, 0).cacheKey;
    const k2 = toSemanticPage(v2, "doc-1", "a".repeat(64), r2.pages[0]!, 0).cacheKey;
    expect(k1).not.toBe(k2);
  });
});
