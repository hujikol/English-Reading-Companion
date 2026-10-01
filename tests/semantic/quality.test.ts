import { describe, expect, it } from "vitest";
import { assessPageQuality, countReplacementChars, garbleRatio, routeSemanticWork } from "../../src/document/quality.ts";
import { normalizeMarkdown } from "../../src/document/normalizer.ts";
import type { InspectorClassification } from "../../src/document/types.ts";

const page = (md: string) => normalizeMarkdown(md);
const base = { hasEncodingIssues: false, cmapUnmapped: 0, pdfType: "TextBased" } as const;

describe("classification is a routing hint, not proof", () => {
  it("calls clean text usable", () => {
    const v = assessPageQuality({ page: page("A normal sentence of readable prose."), needsOcr: false, ...base });
    expect(v.quality).toBe("usable");
    expect(v.warnings).toEqual([]);
  });

  it("calls an empty page unreliable even on a TextBased document", () => {
    const v = assessPageQuality({ page: page(""), needsOcr: false, ...base });
    expect(v.quality).toBe("unreliable");
    expect(v.warnings.join()).toContain("empty-page");
  });

  it("calls a garbled page unreliable", () => {
    const v = assessPageQuality({ page: page("\uE000\uE001\uE002\uE003\uE004\uE005\uE006\uE007\uE008\uE009 done"), needsOcr: false, ...base });
    expect(v.quality).toBe("unreliable");
    expect(v.warnings.join()).toContain("garbled");
  });

  it("calls a page of replacement characters unreliable", () => {
    const v = assessPageQuality({ page: page("\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD"), needsOcr: false, ...base });
    expect(v.quality).toBe("unreliable");
    expect(v.warnings.join()).toContain("replacement-chars");
  });

  it("keeps a lightly affected page usable but records the replacement chars", () => {
    const long = "readable words ".repeat(40);
    const v = assessPageQuality({ page: page(long + "\uFFFD"), needsOcr: false, ...base });
    expect(v.quality).toBe("usable");
    expect(v.warnings.join()).toContain("replacement-chars");
  });

  it("downgrades to partial on encoding warnings", () => {
    const v = assessPageQuality({ page: page("Clean but the font was partly unmapped."), needsOcr: false, hasEncodingIssues: true, cmapUnmapped: 0, pdfType: "TextBased" });
    expect(v.quality).toBe("partial");
    expect(v.warnings.join()).toContain("encoding-issues");
  });

  it("downgrades to partial on cmap gaps with no encoding flag", () => {
    const v = assessPageQuality({ page: page("Clean text, one bad font."), needsOcr: false, hasEncodingIssues: false, cmapUnmapped: 2, pdfType: "TextBased" });
    expect(v.quality).toBe("partial");
    expect(v.warnings.join()).toContain("cmap-gaps");
  });

  it("needs-ocr wins over everything else and explains why", () => {
    const v = assessPageQuality({ page: page(""), needsOcr: true, ocrReasons: ["no text layer"], ...base });
    expect(v.quality).toBe("needs-ocr");
    expect(v.warnings.join()).toContain("OCR is unavailable");
    expect(v.warnings.join()).toContain("no text layer");
  });

  it("treats a mixed document per page", () => {
    const okPage = assessPageQuality({ page: page("Readable."), needsOcr: false, ...base, pdfType: "Mixed" });
    expect(okPage.quality).toBe("usable");
    expect(okPage.warnings.join()).toContain("mixed-document");
  });

  it("counts replacement characters and garbage share", () => {
    expect(countReplacementChars("a\uFFFDb\uFFFD")).toBe(2);
    expect(garbleRatio("")).toBe(1);
    expect(garbleRatio("plain words only")).toBe(0);
  });
});

const classification = (c: Partial<InspectorClassification>): InspectorClassification => ({
  pdfType: "TextBased",
  pageCount: 100,
  pagesNeedingOcr: [],
  confidence: 0.99,
  ...c,
});

describe("routeSemanticWork", () => {
  it("routes a text document to the semantic path", () => {
    expect(routeSemanticWork(classification({}), false).semantic).toBe(true);
  });

  it("does not route a render-only file", () => {
    const r = routeSemanticWork(classification({}), true);
    expect(r.semantic).toBe(false);
    expect(r.reason).toContain("render-only");
  });

  it("does not route a scanned document", () => {
    expect(routeSemanticWork(classification({ pdfType: "Scanned", pagesNeedingOcr: [0, 1] }), false).semantic).toBe(false);
  });

  it("does not route when every page of the document needs OCR", () => {
    // pageCount must describe the document the indexes belong to; a mismatch
    // here means the caller read a different count than it validated against.
    expect(routeSemanticWork(classification({ pageCount: 3, pagesNeedingOcr: [0, 1, 2] }), false).semantic).toBe(false);
  });

  it("routes a mixed document and counts the pages needing OCR", () => {
    const r = routeSemanticWork(classification({ pageCount: 3, pdfType: "Mixed", pagesNeedingOcr: [1, 2] }), false);
    expect(r.semantic).toBe(true);
    expect(r.reason).toContain("2/3");
  });
});
