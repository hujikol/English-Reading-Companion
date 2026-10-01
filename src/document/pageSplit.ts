/**
 * Section 6 semantic path: page association.
 *
 *   "Associate output with pages only through validated markers or single-page
 *    requests. If markers are missing or ambiguous, retry one page at a time
 *    within the job budget. Never infer page boundaries by dividing text lengths."
 *
 * This module never divides text lengths and has no length-based fallback. It
 * reports the failure and lets the job queue issue single-page retries.
 *
 * The upstream marker is `<!-- Page N -->` and N is 1-INDEXED. Upstream also
 * rejects `pages: [0]`, so `toUpstreamPages` is the only place a zero-based
 * index becomes a one-based one.
 */

import type { PageSplit } from "./types.ts";

export const PAGE_MARKER = /^<!--\s*Page\s+(\d+)\s*-->\s*$/;

/** The marker the adapter asks for and therefore the only one it trusts. */
export const PAGE_MARKER_OPTION = { includePageMarkers: true } as const;

/** zero-based internal -> 1-indexed upstream. Throws on 0: upstream rejects it. */
export const toUpstreamPages = (pageIndexes: readonly number[]): number[] => {
  for (const i of pageIndexes) {
    if (!Number.isInteger(i) || i < 0) throw new Error(`page index must be a non-negative integer: ${i}`);
  }
  return pageIndexes.map((i) => i + 1);
};

/** Zero-based, sorted, deduplicated, and bounded to the document. */
export const validatePageIndexes = (pageIndexes: readonly number[], pageCount: number): number[] => {
  const seen = new Set<number>();
  for (const i of pageIndexes) {
    if (!Number.isInteger(i) || i < 0 || i >= pageCount) throw new Error(`page index ${i} outside 0..${pageCount - 1}`);
    seen.add(i);
  }
  return [...seen].sort((a, b) => a - b);
};

/**
 * Every marker in the document, with its position and the 1-indexed page it
 * claims. A document whose markers skip a page, repeat a page, or start
 * anywhere but 1 cannot be split by position alone: `splitByPageMarkers` says so.
 */
export type MarkerScan = { markers: Array<{ pageIndex: number; at: number }> };

export function scanPageMarkers(markdown: string): MarkerScan {
  const markers: Array<{ pageIndex: number; at: number }> = [];
  let at = 0;
  for (const line of markdown.split("\n")) {
    const m = PAGE_MARKER.exec(line.trim());
    if (m) markers.push({ pageIndex: Number(m[1]) - 1, at });
    at += line.length + 1;
  }
  return { markers };
}

/**
 * Split multi-page output into pages by marker.
 *
 * Validation, all of it required before any text is attributed to a page:
 *  - exactly one marker per requested page,
 *  - markers in ascending order and starting at the first requested page,
 *  - no duplicate or missing page number.
 *
 * Any violation returns `ok: false` and the caller retries page by page. A
 * single-page request is unambiguous by construction and is validated as such.
 */
export function splitByPageMarkers(markdown: string, requested: readonly number[], pageCount: number): PageSplit {
  const pages = validatePageIndexes(requested, pageCount);
  const { markers } = scanPageMarkers(markdown);
  const want = pages.map((p) => p + 1);
  const got = markers.map((m) => m.pageIndex + 1);

  const single = pages.length === 1;
  if (single) {
    // Section 6 permits EITHER validated markers OR a single-page request. With
    // exactly one page asked for, the entire output IS that page, so a missing
    // marker is not a boundary failure. Requiring one here made the per-page
    // retry path dead: the fallback called this and could never recover.
    if (got.length === 0) return { ok: true, pages: [{ pageIndex: pages[0]!, markdown }], markerCount: 0, missing: [] };
    // A marker that is present must be the right one. A wrong marker means the
    // engine answered a different question, and trusting the text would
    // attribute page N's text to page M.
    if (got.length !== 1 || got[0] !== want[0]) return { ok: false, reason: "no-markers", markerCount: got.length, requested: pages };
    const at = markers[0]!.at;
    const body = markdown.slice(at).split("\n").slice(1).join("\n");
    return { ok: true, pages: [{ pageIndex: pages[0]!, markdown: body }], markerCount: 1, missing: [] };
  }

  if (markers.length === 0) return { ok: false, reason: "no-markers", markerCount: 0, requested: pages };

  const unique = new Set(got);
  const contiguous = want.every((w, i) => i === 0 || w === want[i - 1]! + 1);
  if (
    got.length !== pages.length ||
    unique.size !== got.length ||
    !contiguous ||
    got[0] !== want[0] ||
    got.some((g, i) => g !== want[i])
  ) {
    return { ok: false, reason: "no-markers", markerCount: got.length, requested: pages };
  }

  const out: Array<{ pageIndex: number; markdown: string }> = [];
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i]!;
    const end = i + 1 < markers.length ? markers[i + 1]!.at : markdown.length;
    // The next marker line starts at `end`; drop that line, keep the body.
    const body = markdown.slice(m.at, end).split("\n").slice(1).join("\n");
    out.push({ pageIndex: m.pageIndex, markdown: body });
  }

  const present = new Set(out.map((p) => p.pageIndex));
  return { ok: true, pages: out, markerCount: markers.length, missing: pages.filter((p) => !present.has(p)) };
}
