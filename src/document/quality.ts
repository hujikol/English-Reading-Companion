/**
 * Section 6 "Classification and fallback": classification is a ROUTING HINT,
 * not proof. A document can be `TextBased` and still have one garbled page, so
 * every verdict here is computed from the page's own text plus the parser's
 * per-page signals.
 *
 * Section 17: "Do not interpret a document classification score as semantic
 * alignment confidence." Nothing here reads `confidence` to raise a quality.
 */

import type { PageQuality } from "../contracts/semantic.ts";
import type { InspectorClassification, InspectorProcessResult } from "./types.ts";
import { textLength } from "./normalizer.ts";
import type { NormalizedPage } from "./types.ts";

export const REPLACEMENT_CHAR = "\uFFFD";

/** A replacement character inside real text means a font CMap had no entry. */
export const countReplacementChars = (text: string): number => {
  let n = 0;
  for (const ch of text) if (ch === REPLACEMENT_CHAR) n++;
  return n;
};

/**
 * Non-word noise: private-use areas, control codes, stray symbol runs.
 *
 * U+FFFD is EXCLUDED. Section 6 lists replacement characters as their own signal
 * beside emptiness and encoding warnings, so a page that is mostly U+FFFD must
 * report `replacement-chars` and not the vaguer `garbled`, or the diagnostic a
 * reader sees fails to name the actual defect.
 */
export const garbleRatio = (text: string): number => {
  if (text.length === 0) return 1;
  let bad = 0;
  for (const ch of text) {
    if (ch === REPLACEMENT_CHAR) continue;
    const cp = ch.codePointAt(0)!;
    const printable = /\p{L}|\p{N}|\p{P}|\p{Zs}/u.test(ch);
    const privateUse = (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0x10fffd);
    if (!printable || privateUse) bad++;
  }
  return bad / text.length;
};

export type QualityInput = {
  page: NormalizedPage;
  /** upstream `pagesNeedingOcr`, 1-indexed */
  needsOcr: boolean;
  hasEncodingIssues: boolean;
  /** unmapped codes for this page's fonts; a global list would poison siblings */
  cmapUnmapped: number;
  pdfType: InspectorProcessResult["pdfType"];
  ocrReasons?: string[];
};

export type QualityVerdict = { quality: PageQuality; warnings: string[] };

const GARBLE_THRESHOLD = 0.2;
const REPLACEMENT_THRESHOLD = 0.005;

export function assessPageQuality(input: QualityInput): QualityVerdict {
  const warnings: string[] = [];
  const chars = textLength(input.page);
  const replacement = countReplacementChars(input.page.text);
  const garble = garbleRatio(input.page.text);

  // Needs-OCR wins: a scanned page keeps rendering, and the reader explains
  // that OCR is unavailable in this release.
  if (input.needsOcr || input.pdfType === "Scanned" || input.pdfType === "ImageBased") {
    warnings.push("needs-ocr: no selectable text on this page; OCR is unavailable in this release");
    if (input.ocrReasons?.length) warnings.push(`ocr-reasons: ${input.ocrReasons.join("; ")}`);
    return { quality: "needs-ocr", warnings };
  }

  if (chars === 0) {
    warnings.push("empty-page: no text extracted");
    return { quality: "unreliable", warnings };
  }

  if (garble >= GARBLE_THRESHOLD) {
    warnings.push(`garbled: ${(garble * 100).toFixed(1)}% non-text characters`);
    return { quality: "unreliable", warnings };
  }

  if (replacement > 0) {
    const share = replacement / chars;
    warnings.push(`replacement-chars: ${replacement} U+FFFD (${(share * 100).toFixed(2)}% of page text)`);
    if (share >= REPLACEMENT_THRESHOLD) return { quality: "unreliable", warnings };
  }

  if (input.hasEncodingIssues || input.cmapUnmapped > 0) {
    warnings.push(
      input.hasEncodingIssues
        ? "encoding-issues: parser reported encoding problems"
        : `cmap-gaps: ${input.cmapUnmapped} codes had no ToUnicode entry`,
    );
    return { quality: "partial", warnings };
  }

  // Mixed documents get per-page treatment: a text page next to a scan is usable,
  // but the reader still has to show the limitation, so it is recorded.
  if (input.pdfType === "Mixed") warnings.push("mixed-document: limitations are reported per page");

  return { quality: "usable", warnings };
}

/**
 * Document classification is routing only: it decides whether the semantic path
 * is worth starting, never whether a page's text is trustworthy.
 */
export type RoutingDecision = { semantic: boolean; reason: string };

export const routeSemanticWork = (c: InspectorClassification, renderOnly: boolean): RoutingDecision => {
  if (renderOnly) return { semantic: false, reason: "render-only: file is above the device size tier" };
  if (c.pdfType === "Scanned" || c.pdfType === "ImageBased")
    return { semantic: false, reason: "scanned: no text layer; OCR is unavailable in this release" };
  if (c.pagesNeedingOcr.length === c.pageCount)
    return { semantic: false, reason: "every page needs OCR; semantic path would produce nothing" };
  return { semantic: true, reason: `pdfType=${c.pdfType}, ${c.pagesNeedingOcr.length}/${c.pageCount} pages need OCR` };
};
