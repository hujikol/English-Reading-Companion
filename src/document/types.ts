/**
 * Track E internal types. The frozen cross-track shapes live in src/contracts;
 * these are the adapter's own view of the upstream WASM API and never leak out.
 *
 * Nothing here has geometry. The inspector WASM wrapper exports no positioned
 * API, so there is nothing to map and nothing to invent (ADR 004).
 */

import type { PageQuality, ParserSource, SemanticBlock } from "../contracts/semantic.ts";

/**
 * Canonical page text plus blocks. Markdown is never this type: it is adapter
 * input only, and what leaves the normalizer is plain text with UTF-16 offsets
 * (Section 6, ADR 009).
 */
export type NormalizedPage = {
  text: string;
  blocks: SemanticBlock[];
};

export type { PageQuality };

/** Upstream `PdfProcessResult`, 1-INDEXED page numbers. */
export type InspectorPdfType = "TextBased" | "Scanned" | "ImageBased" | "Mixed";

export type InspectorOptions = {
  /** 1-indexed. Page 0 is rejected upstream. */
  pages?: number[];
  password?: string;
  profile?: "fidelity" | "compact";
  includePageMarkers?: boolean;
  includeImages?: boolean;
};

export type InspectorCmapGap = { font: string; codes: number; interpolated: number; unmapped: number };

export type InspectorProcessResult = {
  pdfType: InspectorPdfType;
  markdown?: string;
  pageCount: number;
  processingTimeMs: number;
  /** 1-indexed */
  pagesNeedingOcr: number[];
  /** 1-indexed */
  ocrReasonsByPage: Array<{ page: number; reasons: string[] }>;
  confidence: number;
  /** 1-indexed */
  layout: { isComplex: boolean; pagesWithTables: number[]; pagesWithColumns: number[] };
  hasEncodingIssues: boolean;
  cmapGaps: InspectorCmapGap[];
};

/** Upstream `PdfClassification`: same shape as the native Node API, 0-INDEXED. */
export type InspectorClassification = {
  pdfType: InspectorPdfType;
  pageCount: number;
  /** 0-indexed — differs from processPdf on purpose upstream. */
  pagesNeedingOcr: number[];
  confidence: number;
};

/** The only surface this project depends on. A fake satisfies it in tests. */
export type InspectorEngine = {
  version(): string;
  processPdf(bytes: Uint8Array, options?: InspectorOptions): InspectorProcessResult;
  classifyPdf(bytes: Uint8Array): InspectorClassification;
};

/** Engine identity used in the extraction key and in `SemanticPage.source`. */
export const INSPECTOR_ENGINE = "inspector-wasm";

/** Markdown split into validated page-addressed pieces, plus why it failed. */
export type PageSplit =
  | { ok: true; pages: Array<{ pageIndex: number; markdown: string }>; markerCount: number; missing: number[] }
  | { ok: false; reason: "no-markers"; markerCount: number; requested: number[] };

/** One page's canonical data plus the quality verdict that gates its use. */
export type ExtractedPage = {
  pageIndex: number;
  text: string;
  blocks: SemanticBlock[];
  source: ParserSource;
  quality: PageQuality;
  warnings: string[];
  /** upstream pageCount, so the caller can validate later page requests */
  parserPageCount: number;
  processingTimeMs: number;
  pdfType: InspectorPdfType;
  needsOcr: boolean;
};

/** Frozen schema revision of `SemanticPage`. Bump with a normalizer change. */
export const SEMANTIC_SCHEMA_VERSION = 1;

/** Bump when normalized text/blocks change; it is part of the extraction key. */
export const NORMALIZER_VERSION = "semantic-normalizer@1";
