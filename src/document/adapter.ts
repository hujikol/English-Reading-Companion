/**
 * The semantic adapter. Everything upstream-specific stops here: 1-indexed page
 * numbers, `<!-- Page N -->` markers, Markdown, classification shape. What leaves
 * is `ExtractedPage` — canonical text plus a quality verdict.
 *
 * The WASM engine is injected, so nothing here imports
 * `@firecrawl/pdf-inspector-wasm` and tests drive `FakeInspector`.
 *
 * Section 6 memory rule: bytes are held ONCE per adapter, not sent per page. A
 * transferred ArrayBuffer detaches in its sender, so the buffer is copied into
 * the adapter here and the caller releases its own reference.
 */

import { extractionKey, optionsHash } from "./cacheKey.ts";
import { normalizeMarkdown } from "./normalizer.ts";
import { PAGE_MARKER_OPTION, splitByPageMarkers, toUpstreamPages, validatePageIndexes } from "./pageSplit.ts";
import { assessPageQuality } from "./quality.ts";
import type { ExtractedPage, InspectorEngine, InspectorOptions, InspectorProcessResult, InspectorPdfType } from "./types.ts";
import { INSPECTOR_ENGINE, SEMANTIC_SCHEMA_VERSION } from "./types.ts";
import { normalizerVersion } from "./normalizer.ts";
import type { SemanticPage } from "../contracts/semantic.ts";

export type AdapterError = { kind: "password-required"; message: string } | { kind: "engine-failure"; message: string };

export type ExtractResult =
  | {
      ok: true;
      pages: ExtractedPage[];
      parserVersion: string;
      parserPageCount: number;
      /** true when markers failed and pages were retried one at a time */
      retriedIndividually: boolean;
    }
  | ({ ok: false } & AdapterError);

export type AdapterInit = {
  bytes: Uint8Array;
  pageCount: number;
  password?: string | undefined;
  profile?: "fidelity" | "compact";
  includeImages?: boolean;
};

export type InspectorAdapter = {
  engine: InspectorEngine;
  parserVersion: string;
  /** upstream pageCount, learned from the first call or an OPEN handshake */
  pageCount: number;
  password?: string | undefined;
  profile: "fidelity" | "compact";
  includeImages: boolean;
  /** held once per active document; released by `closeAdapter` */
  bytes: Uint8Array | null;
};

export const createAdapter = (engine: InspectorEngine, init: AdapterInit): InspectorAdapter => ({
  engine,
  parserVersion: engine.version(),
  pageCount: init.pageCount,
  password: init.password,
  profile: init.profile ?? "fidelity",
  includeImages: init.includeImages ?? false,
  // copy: the caller's buffer may be transferred to PDF.js afterwards.
  bytes: new Uint8Array(init.bytes),
});

/** Release parser input on CLOSE or document change. */
export const closeAdapter = (adapter: InspectorAdapter): InspectorAdapter => ({ ...adapter, bytes: null, pageCount: 0 });

export const adapterOptionsHash = (a: InspectorAdapter): string =>
  optionsHash({ profile: a.profile, includePageMarkers: true, includeImages: a.includeImages });

const upstreamOptions = (a: InspectorAdapter, pages: number[]): InspectorOptions => ({
  pages: toUpstreamPages(pages),
  ...PAGE_MARKER_OPTION,
  ...(a.password !== undefined ? { password: a.password } : {}),
  profile: a.profile,
  includeImages: a.includeImages,
});

const PASSWORD_HINTS = /password|encrypt/i;
const isPasswordError = (e: unknown): boolean =>
  PASSWORD_HINTS.test(e instanceof Error ? e.message : String(e));

/** One upstream call. Returns the raw result or a typed failure. */
type Call = { ok: true; result: InspectorProcessResult } | ({ ok: false } & AdapterError);

function callEngine(a: InspectorAdapter, pages: number[]): Call {
  if (a.bytes === null) return { ok: false, kind: "engine-failure", message: "adapter is closed: parser input was released" };
  try {
    const result = a.engine.processPdf(a.bytes, upstreamOptions(a, pages));
    if (result.pageCount > 0) a.pageCount = result.pageCount;
    return { ok: true, result };
  } catch (e) {
    return isPasswordError(e)
      ? { ok: false, kind: "password-required", message: e instanceof Error ? e.message : String(e) }
      : { ok: false, kind: "engine-failure", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Per-page quality inputs, read from the whole-document result. */
const qualityInputs = (r: InspectorProcessResult, pageIndex: number) => ({
  needsOcr: r.pagesNeedingOcr.includes(pageIndex + 1),
  hasEncodingIssues: r.hasEncodingIssues,
  cmapUnmapped: r.cmapGaps.filter((g) => g.unmapped > 0).length,
  pdfType: r.pdfType,
  ocrReasons: r.ocrReasonsByPage.find((o) => o.page === pageIndex + 1)?.reasons ?? [],
});

const toExtracted = (pageIndex: number, markdown: string, r: InspectorProcessResult): ExtractedPage => {
  const page = normalizeMarkdown(markdown);
  const { quality, warnings } = assessPageQuality({ page, ...qualityInputs(r, pageIndex) });
  return {
    pageIndex,
    text: page.text,
    blocks: page.blocks,
    source: INSPECTOR_ENGINE,
    quality,
    warnings,
    parserPageCount: r.pageCount,
    processingTimeMs: r.processingTimeMs,
    pdfType: r.pdfType,
    needsOcr: r.pagesNeedingOcr.includes(pageIndex + 1),
  };
};

/** One page, requested and validated on its own. Unambiguous by construction. */
function extractSingle(a: InspectorAdapter, pageIndex: number): ExtractedPage | null {
  const call = callEngine(a, [pageIndex]);
  if (!call.ok) return null;
  const split = splitByPageMarkers(call.result.markdown ?? "", [pageIndex], a.pageCount);
  if (!split.ok || split.pages.length !== 1) return null;
  const only = split.pages[0]!;
  return toExtracted(only.pageIndex, only.markdown, call.result);
}

const succeed = (pages: ExtractedPage[], a: InspectorAdapter, retriedIndividually: boolean): ExtractResult => ({
  ok: true,
  pages,
  parserVersion: a.parserVersion,
  parserPageCount: a.pageCount,
  retriedIndividually,
});

/**
 * Extract and normalize a bounded page list. Never throws: an upstream failure
 * becomes a typed result so reading continues (Section 6 fallback table).
 *
 * Markers missing or ambiguous -> one call per page. Text is NEVER divided by
 * page count to guess a boundary.
 */
export function extractPages(a: InspectorAdapter, pageIndexes: readonly number[]): ExtractResult {
  let pages: number[];
  try {
    pages = validatePageIndexes(pageIndexes, Math.max(a.pageCount, 1));
  } catch (e) {
    return { ok: false, kind: "engine-failure", message: e instanceof Error ? e.message : String(e) };
  }
  if (pages.length === 0) return { ok: false, kind: "engine-failure", message: "no valid page indexes requested" };

  const call = callEngine(a, pages);
  if (!call.ok) return call;

  const split = splitByPageMarkers(call.result.markdown ?? "", pages, a.pageCount);
  if (split.ok) return succeed(split.pages.map((p) => toExtracted(p.pageIndex, p.markdown, call.result)), a, false);

  // Markers are untrustworthy for this batch. Retry page by page, once.
  const recovered: ExtractedPage[] = [];
  for (const pageIndex of pages) {
    const one = extractSingle(a, pageIndex);
    if (one !== null) recovered.push(one);
  }
  if (recovered.length === pages.length) return succeed(recovered, a, true);

  return {
    ok: false,
    kind: "engine-failure",
    message: `page markers unvalidated for [${pages.join(",")}]; per-page retry recovered ${recovered.length}/${pages.length}`,
  };
}

/**
 * The derived-page row. Marks and occurrences never live in this store: it is
 * evictable, and one parser upgrade would then delete a highlight.
 */
export function toSemanticPage(
  a: InspectorAdapter,
  documentId: string,
  contentHash: string,
  page: ExtractedPage,
  now: number,
): SemanticPage {
  return {
    cacheKey: extractionKey({
      contentHash,
      parserEngine: INSPECTOR_ENGINE,
      parserVersion: a.parserVersion,
      optionsHash: adapterOptionsHash(a),
      normalizerVersion,
      pageIndex: page.pageIndex,
    }),
    documentId,
    pageIndex: page.pageIndex,
    parser: INSPECTOR_ENGINE,
    parserVersion: a.parserVersion,
    optionsHash: adapterOptionsHash(a),
    normalizerVersion,
    schemaVersion: SEMANTIC_SCHEMA_VERSION,
    text: page.text,
    blocks: page.blocks,
    source: page.source,
    quality: page.quality,
    warnings: page.warnings,
    createdAt: now,
    lastAccessedAt: now,
  };
}

export { INSPECTOR_ENGINE };
export type { InspectorPdfType };
