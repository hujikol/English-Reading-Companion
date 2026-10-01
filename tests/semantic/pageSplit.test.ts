import { describe, expect, it } from "vitest";
import { scanPageMarkers, splitByPageMarkers, toUpstreamPages, validatePageIndexes } from "../../src/document/pageSplit.ts";

const marker = (n: number) => `<!-- Page ${n} -->\nbody of page ${n}\n`;

describe("page numbering", () => {
  it("converts zero-based internal pages to the upstream one-based form", () => {
    expect(toUpstreamPages([0, 4, 9])).toEqual([1, 5, 10]);
  });

  it("refuses page 0, which upstream rejects outright", () => {
    // toUpstreamPages receives already-validated pages; -1 is how a bug arrives.
    expect(() => toUpstreamPages([-1])).toThrow(/non-negative/);
  });

  it("validates, deduplicates and sorts page requests against the document", () => {
    expect(validatePageIndexes([3, 0, 3, 1], 10)).toEqual([0, 1, 3]);
    expect(() => validatePageIndexes([10], 10)).toThrow(/outside/);
    expect(() => validatePageIndexes([-1], 10)).toThrow(/outside/);
  });
});

describe("splitByPageMarkers", () => {
  it("splits a marked batch into validated pages", () => {
    const md = [marker(3), marker(4), marker(5)].join("\n");
    const split = splitByPageMarkers(md, [2, 3, 4], 10);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.markerCount).toBe(3);
    expect(split.pages.map((p) => p.pageIndex)).toEqual([2, 3, 4]);
    expect(split.pages[0]!.markdown.trim()).toBe("body of page 3");
    expect(split.missing).toEqual([]);
  });

  it("reports no markers instead of guessing boundaries", () => {
    const split = splitByPageMarkers("one\n\ntwo\n\nthree", [0, 1, 2], 3);
    expect(split).toEqual({ ok: false, reason: "no-markers", markerCount: 0, requested: [0, 1, 2] });
  });

  it("rejects an ambiguous marker set: duplicated page", () => {
    const split = splitByPageMarkers(marker(3) + marker(3), [2, 3], 10);
    expect(split.ok).toBe(false);
    expect(split.markerCount).toBe(2);
  });

  it("rejects an ambiguous marker set: missing middle page", () => {
    const md = [marker(3), marker(5)].join("\n");
    const split = splitByPageMarkers(md, [2, 3, 4], 10);
    expect(split.ok).toBe(false);
  });

  it("rejects an ambiguous marker set: markers out of order", () => {
    const md = [marker(5), marker(3)].join("\n");
    expect(splitByPageMarkers(md, [2, 4], 10).ok).toBe(false);
  });

  it("rejects a marker for a page that was not requested", () => {
    expect(splitByPageMarkers(marker(1) + marker(2), [1], 10).ok).toBe(false);
  });

  it("accepts a single-page request validated against its own marker", () => {
    const split = splitByPageMarkers(marker(7), [6], 10);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.pages).toEqual([{ pageIndex: 6, markdown: "body of page 7\n" }]);
  });

  it("rejects a single-page request whose marker names another page", () => {
    expect(splitByPageMarkers(marker(8), [6], 10).ok).toBe(false);
  });

  it("keeps marker bodies free of the next marker line", () => {
    const md = [marker(1), marker(2)].join("\n");
    const split = splitByPageMarkers(md, [0, 1], 10);
    if (!split.ok) throw new Error("expected a valid split");
    for (const p of split.pages) expect(p.markdown).not.toContain("<!-- Page");
  });

  it("scans markers with their offsets", () => {
    const md = "intro\n" + marker(2);
    const scan = scanPageMarkers(md);
    expect(scan.markers).toEqual([{ pageIndex: 1, at: 6 }]);
  });
});
