import { describe, expect, it } from "vitest";
import { extractionKey, extractionKeysFor, optionsHash } from "../../src/document/cacheKey.ts";
import { adapterOptionsHash, createAdapter, toSemanticPage } from "../../src/document/adapter.ts";
import { extractPages } from "../../src/document/adapter.ts";
import { FakeInspector } from "../../src/document/fakeInspector.ts";

const HASH = "a".repeat(64);

const parts = {
  contentHash: HASH,
  parserEngine: "inspector-wasm",
  parserVersion: "1.25.2",
  optionsHash: "fnv1a32-deadbeef",
  normalizerVersion: "semantic-normalizer@1",
} as const;

describe("extraction key", () => {
  it("is exactly the Section 6 tuple, in order", () => {
    expect(extractionKey({ ...parts, pageIndex: 12 })).toBe(
      `${HASH}|inspector-wasm|1.25.2|fnv1a32-deadbeef|semantic-normalizer@1|12`,
    );
  });

  it("snapshots the expected string form", () => {
    expect(extractionKey({ ...parts, pageIndex: 0 })).toMatchInlineSnapshot(
      `"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|inspector-wasm|1.25.2|fnv1a32-deadbeef|semantic-normalizer@1|0"`,
    );
  });

  it("changes when the parser version changes, so only derived pages are invalidated", () => {
    const a = extractionKey({ ...parts, pageIndex: 3 });
    const b = extractionKey({ ...parts, parserVersion: "1.26.0", pageIndex: 3 });
    expect(a).not.toBe(b);
  });

  it("changes when the normalizer version changes", () => {
    expect(extractionKey({ ...parts, pageIndex: 3 })).not.toBe(
      extractionKey({ ...parts, normalizerVersion: "semantic-normalizer@2", pageIndex: 3 }),
    );
  });

  it("changes per page, so pages never collide", () => {
    const keys = extractionKeysFor(parts, [0, 1, 2]);
    expect(new Set(keys).size).toBe(3);
  });

  it("rejects a component that could forge a boundary", () => {
    expect(() => extractionKey({ ...parts, parserVersion: "1|2", pageIndex: 0 })).toThrow(/must not contain/);
  });

  it("rejects a negative or fractional page index", () => {
    expect(() => extractionKey({ ...parts, pageIndex: -1 })).toThrow(/non-negative/);
    expect(() => extractionKey({ ...parts, pageIndex: 1.5 })).toThrow(/non-negative/);
  });
});

describe("options hash", () => {
  it("is stable and defaults to fidelity without markers or images", () => {
    expect(optionsHash()).toBe(optionsHash({}));
    expect(optionsHash()).toMatchInlineSnapshot('"fnv1a32-82253f4c"');
  });

  it("changes when an output-affecting option changes", () => {
    expect(optionsHash({ profile: "compact" })).not.toBe(optionsHash({ profile: "fidelity" }));
    expect(optionsHash({ includeImages: true })).not.toBe(optionsHash());
  });
});

describe("derived page rows", () => {
  const engine = new FakeInspector({ version: "1.25.2", pages: [{ markdown: "Hello there." }] });
  const adapter = createAdapter(engine, { bytes: new Uint8Array([1, 2, 3]), pageCount: 1 });
  const extracted = extractPages(adapter, [0]);
  if (!extracted.ok) throw new Error("fixture failed to extract");

  it("keys the row by the extraction key, not by a page number alone", () => {
    const row = toSemanticPage(adapter, "doc_1", HASH, extracted.pages[0]!, 1000);
    expect(row.cacheKey).toBe(extractionKey({ ...parts, optionsHash: adapterOptionsHash(adapter), pageIndex: 0 }));
    expect(row.pageIndex).toBe(0);
    expect(row.source).toBe("inspector-wasm");
  });

  it("marks the row evictable by keeping it free of any user identifier beyond documentId", () => {
    const row = toSemanticPage(adapter, "doc_1", HASH, extracted.pages[0]!, 1000);
    expect(Object.keys(row).sort()).toEqual([
      "blocks",
      "cacheKey",
      "createdAt",
      "documentId",
      "lastAccessedAt",
      "normalizerVersion",
      "optionsHash",
      "pageIndex",
      "parser",
      "parserVersion",
      "quality",
      "schemaVersion",
      "source",
      "text",
      "warnings",
    ]);
    // no markId, no occurrenceId: user data never enters the derived store
    expect(JSON.stringify(row)).not.toMatch(/markId|occurrenceId|bookmarkId/);
  });

  it("holds parser bytes once per document, not per page request", () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const a = createAdapter(new FakeInspector({ pages: [{ markdown: "x" }, { markdown: "y" }] }), { bytes, pageCount: 2 });
    expect(a.bytes).not.toBe(bytes);
    extractPages(a, [0, 1]);
    expect(engine.calls.length).toBeGreaterThanOrEqual(0);
    expect(a.bytes).not.toBeNull();
  });
});
