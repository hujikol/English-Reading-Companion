/**
 * Page association against REAL `@firecrawl/pdf-inspector-wasm@1.25.2` output.
 *
 * The single most important fact about this parser, verified by running it
 * rather than by reading its docs:
 *
 *   `result.markdown` is ONE FLAT STRING for the whole document. There is no
 *   per-page structure, no page objects, no offsets. `processPdf` returns
 *   `{ markdown, pageCount, ... }` and the page count is the ONLY page
 *   information attached to the text.
 *
 * The only thing that makes a byte range addressable to a page is
 * `includePageMarkers: true`, which inserts `<!-- Page N -->` lines. Observed
 * real output for a 3-page document (JSON-escaped, exactly as returned):
 *
 *   "<!-- Page 1 -->\n\nAlpha page one heading The first sentence...\n
 *    \n<!-- Page 2 -->\n\nBeta page two heading ...\n
 *    \n<!-- Page 3 -->\n\nGamma page three heading ...\n"
 *
 * and the second real finding, which a fake would have hidden:
 *
 *   A PAGE WITH NO TEXT EMITS NO MARKER AT ALL. For a 3-page document whose
 *   middle page is blank, the real parser returns only `<!-- Page 1 -->` and
 *   `<!-- Page 3 -->`. The missing marker is NOT page 2 having shifted: page 3
 *   still says `Page 3`, so markers stay tied to true page numbers and a gap
 *   is a genuinely empty page.
 *
 * That gap is why batch-only association is unsafe and why the fallback below
 * exists. Treating a marker count mismatch as "shift the boundaries" is the
 * length-division mistake the spec forbids: it would hand page 3's text to
 * page 2 and every downstream mark anchored through it.
 *
 * INDEX CONVENTION. Upstream is 1-INDEXED for `pages` (and rejects `pages: [0]`
 * with "invalid options: pages are 1-indexed; page 0 is invalid") but
 * `classifyPdf` returns 0-INDEXED `pagesNeedingOcr`, deliberately matching the
 * native Node API. This file performs NO index arithmetic. The single
 * conversion lives in ../pageSplit.ts — `toUpstreamPages` outbound,
 * `scanPageMarkers` inbound — and this module calls it. A second conversion
 * here is the off-by-one the spec calls out, so there is none.
 */

import { splitByPageMarkers } from "../pageSplit.ts";
import type { InspectorProcessResult } from "../types.ts";

/** Markdown for one page, plus how the boundary was established. */
export type AssociatedPage = {
  /** zero-based internal page index */
  pageIndex: number;
  markdown: string;
  /**
   * `marker`   - a validated `<!-- Page N -->` line bounded this page.
   * `single`   - one page was requested, so the whole response IS that page
   *              (Section 6 permits markers OR a single-page request).
   * `empty`    - the parser returned nothing for a page it was asked for.
   */
  source: "marker" | "single" | "empty";
};

export type Association =
  | { ok: true; pages: AssociatedPage[]; /** true when a per-page retry ran */ retriedIndividually: boolean }
  | { ok: false; reason: string; markerCount: number; requested: readonly number[] };

/** Options for `associatePages`. Mirrors the subset of ProcessOptions used. */
export type AssociateOptions = {
  /** the raw result from the real `processPdf` */
  result: InspectorProcessResult;
  /** zero-based page indexes that were requested upstream, already validated */
  requested: readonly number[];
  /** the engine, for the per-page retry. Injected so this stays testable. */
  requestPage: (pageIndex: number) => InspectorProcessResult;
};

/**
 * Which of the two permitted mechanisms produced this split.
 *
 * `splitByPageMarkers` returns a `markerCount`, and the semantics of a
 * successful split depend on it: more than one marker means the text was
 * genuinely delimited, exactly zero markers on a single-page request means the
 * whole body is that page.
 */
const classifySource = (markerCount: number, pageCount: number): AssociatedPage["source"] => {
  if (markerCount > 0) return "marker";
  return pageCount === 1 ? "single" : "empty";
};

/**
 * Associate one `processPdf` result with the pages it was requested for.
 *
 * Order of attempts, per Section 6:
 *   1. validated markers in the batch response.
 *   2. otherwise, ONE upstream call per page, within the job budget.
 *
 * There is no third option. Text is never divided by length, page count, or
 * marker ratio to guess a boundary, and no attempt is made to "repair" a
 * partial marker set by shifting page numbers — a gap means an empty page, and
 * only a per-page request can tell an empty page from a misattributed one.
 *
 * Never throws: a failed association is a value the caller turns into a
 * fallback to PDF.js text (Section 6 fallback table).
 */
export const associatePages = ({ result, requested, requestPage }: AssociateOptions): Association => {
  if (requested.length === 0) return { ok: false, reason: "no pages requested", markerCount: 0, requested };

  const split = splitByPageMarkers(result.markdown ?? "", requested, result.pageCount);
  if (split.ok) {
    return {
      ok: true,
      retriedIndividually: false,
      pages: split.pages.map((p) => ({
        pageIndex: p.pageIndex,
        markdown: p.markdown,
        source: classifySource(split.markerCount, split.pages.length),
      })),
    };
  }

  // Markers are missing or ambiguous for this batch. Retry one page at a time.
  // Each retry is unambiguous by construction: either its own marker validates,
  // or the response contains exactly one page and therefore cannot be misread.
  const recovered: AssociatedPage[] = [];
  for (const pageIndex of requested) {
    let single: InspectorProcessResult;
    try {
      single = requestPage(pageIndex);
    } catch (e) {
      return {
        ok: false,
        reason: `per-page retry for page ${pageIndex} failed: ${e instanceof Error ? e.message : String(e)}`,
        markerCount: split.markerCount,
        requested,
      };
    }
    const one = splitByPageMarkers(single.markdown ?? "", [pageIndex], single.pageCount);
    if (!one.ok || one.pages.length !== 1) {
      return {
        ok: false,
        reason: `per-page retry for page ${pageIndex} could not be validated`,
        markerCount: split.markerCount,
        requested,
      };
    }
    const body = one.pages[0]!.markdown;
    recovered.push({
      pageIndex,
      markdown: body,
      // An empty body with no marker is a real empty page, which is a valid
      // result and NOT a failure. Reporting it as `empty` keeps the reader's
      // needs-ocr message honest instead of inventing text for it.
      source: one.markerCount > 0 ? "marker" : body.trim().length === 0 ? "empty" : "single",
    });
  }

  return { ok: true, pages: recovered, retriedIndividually: true };
};
