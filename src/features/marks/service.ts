/**
 * Track E: highlights saved by the reader, and the geometry-free re-anchoring
 * that restores them.
 *
 * Section 7: because no stored anchor contains geometry, "restoring a saved mark
 * means re-finding its text in current extraction output, and a mark whose text
 * can no longer be located must report anchorState: 'lost' rather than silently
 * failing to draw."
 *
 * Shared by PDF (against SemanticPage rows) and by reflowable formats (against
 * the renderer's current text) — both go through the same `Indexer`, so EPUB/TXT/
 * Markdown need no PDF parser (E2).
 *
 * Marks are USER DATA. They live in the `marks` table, keyed by documentId, and
 * are never written into `semanticPages`.
 */

import type { Anchor, AnchorState, Locator, Mark } from "../../contracts/index.ts";
import type { IndexedPage } from "../../document/align.ts";
import { alignSelection, indexPages } from "../../document/align.ts";

export type { Anchor, AnchorState, Locator, Mark };

/** A place text can be found: a semantic page or a reflowable block range. */
export type AnchorTarget = IndexedPage;

export type ResolvedSpan = {
  pageIndex: number;
  start: number;
  end: number;
  kind: "unique" | "prefix-suffix" | "neighbour" | "hyphenated";
  context: string | null;
};

/**
 * One index per mount. Built once per page for the whole mark set, then reused:
 * the dense case is many marks against one page, and normalizing per mark turns
 * O(pages) into O(marks x pages).
 */
export type PageIndex = {
  pages: AnchorTarget[];
  /** number of pages normalized; asserted by the dense-page test */
  builtPages: number;
};

export const buildPageIndex = (targets: readonly AnchorTarget[]): PageIndex => {
  const pages = indexPages(targets);
  return { pages, builtPages: pages.length };
};

/**
 * Which pages an anchor could live in: ALL indexed pages, for every format.
 *
 * IDEA.md section 7: "restoring a saved mark means re-finding its text in current
 * extraction output". The stored locator is a HINT about where the text was, not
 * a filter — restricting the search to that one page reports "lost" for a mark
 * that is still in the document, which is exactly the silent failure the spec
 * forbids. Section 7 step 3 ("search only relevant semantic pages") is about not
 * searching the whole FILE on every selection; here the whole window is already
 * indexed, so one pass over prebuilt strings replaces per-mark re-normalization.
 *
 * Cost stays flat because the index is built once per mount (see `buildPageIndex`
 * and the dense-page test). Correctness on the cheap path would be a guess; this
 * is not a guess.
 */

export type AnchorOutcome =
  | { anchorState: "resolved"; span: ResolvedSpan; anchor: Anchor }
  | { anchorState: "unresolved"; reason: string; candidates: number; anchor: Anchor }
  | { anchorState: "lost"; reason: string; anchor: Anchor };

/**
 * Re-find one anchor against current text. `anchorState` is REWRITTEN every time:
 * a previously resolved anchor that no longer matches becomes unresolved or
 * lost. Returning the previous state would leave a stale "resolved" row that
 * claims to be visible when it is not.
 */
export function reanchor(mark: Mark, index: PageIndex, now: number): AnchorOutcome {
  const quote = mark.anchor.quote ?? "";
  if (quote.trim().length === 0)
    return { anchorState: "lost", reason: "empty-quote", anchor: { ...mark.anchor, anchorState: "lost" } };

  const result = alignSelection({
    selection: quote,
    // The stored page is only a search hint, so it orders the candidates.
    selectionPageIndex: mark.anchor.locator.kind === "pdf" ? mark.anchor.locator.pageIndex : -1,
    prefix: mark.anchor.prefix,
    suffix: mark.anchor.suffix,
    pages: index.pages,
  });

  if (result.status === "aligned") {
    const anchor: Anchor = {
      ...mark.anchor,
      anchorState: "resolved",
      resolvedAt: now,
      // The page the text is actually on wins over the stored locator: the
      // document may have been re-flowed or the parser re-ordered.
      locator: rewriteLocator(mark.anchor.locator, result.pageIndex),
    };
    return {
      anchorState: "resolved",
      span: { pageIndex: result.pageIndex, start: result.start, end: result.end, kind: result.kind, context: result.context },
      anchor,
    };
  }

  // Ambiguous and not-found are different failures and stay distinguishable:
  // ambiguous means the text exists in more than one place, not-found means the
  // text is gone. Both are visible states; neither is a guess.
  const reason = result.status === "ambiguous" ? `ambiguous: ${result.reason}` : `not-found: ${result.reason}`;
  if (result.status === "ambiguous") {
    const anchor: Anchor = { ...mark.anchor, anchorState: "unresolved" };
    return { anchorState: "unresolved", reason, candidates: result.candidates, anchor };
  }
  const anchor: Anchor = { ...mark.anchor, anchorState: "lost" };
  return { anchorState: "lost", reason, anchor };
}

const rewriteLocator = (locator: Locator, pageIndex: number): Locator => {
  if (locator.kind !== "pdf") return locator;
  return { ...locator, pageIndex };
};

/**
 * Re-anchor a set against one index. Every mark gets a verdict: an unlocatable
 * mark is reported, never silently left undrawn.
 */
export type ReanchorReport = {
  resolved: Array<{ mark: Mark; span: ResolvedSpan; anchor: Anchor }>;
  unresolved: Array<{ mark: Mark; reason: string; candidates: number; anchor: Anchor }>;
  lost: Array<{ mark: Mark; reason: string; anchor: Anchor }>;
  /** marks examined, including soft-deleted ones the caller passed in */
  examined: number;
};

export function reanchorAll(marks: readonly Mark[], index: PageIndex, now: number): ReanchorReport {
  const report: ReanchorReport = { resolved: [], unresolved: [], lost: [], examined: marks.length };
  for (const mark of marks) {
    const outcome = reanchor(mark, index, now);
    if (outcome.anchorState === "resolved") report.resolved.push({ mark, span: outcome.span, anchor: outcome.anchor });
    else if (outcome.anchorState === "unresolved")
      report.unresolved.push({ mark, reason: outcome.reason, candidates: outcome.candidates, anchor: outcome.anchor });
    else report.lost.push({ mark, reason: outcome.reason, anchor: outcome.anchor });
  }
  return report;
}

/** Live marks for a document: soft-deleted rows are excluded, not re-anchored. */
export const liveMarks = (marks: readonly Mark[], documentId: string): Mark[] =>
  marks.filter((m) => m.documentId === documentId && m.deletedAt === undefined);

export const markOverlaps = (a: ResolvedSpan, b: ResolvedSpan): boolean =>
  a.pageIndex === b.pageIndex && a.start < b.end && b.start < a.end;
