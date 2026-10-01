/**
 * Test double for the inspector WASM engine.
 *
 * The real package is not installed in this repo, so this is the only thing that
 * satisfies `InspectorEngine`. It reproduces the two behaviours that actually
 * break naive adapters:
 *   - `pages` is 1-indexed and page 0 is rejected
 *   - `processPdf` needs `includePageMarkers` to emit `<!-- Page N -->`
 * and `classifyPdf` deliberately returns 0-indexed pages, like the native API.
 *
 * Tests script its per-page markdown, so a fixture can produce missing markers,
 * duplicate markers, replacement characters or an empty page on demand.
 */

import type {
  InspectorClassification,
  InspectorEngine,
  InspectorOptions,
  InspectorPdfType,
  InspectorProcessResult,
} from "./types.ts";

export type FakePageSpec = {
  /** markdown body for this page; a marker is prepended automatically */
  markdown: string;
  needsOcr?: boolean;
  ocrReasons?: string[];
};

export type FakeInspectorSpec = {
  version?: string;
  pdfType?: InspectorPdfType;
  pages: FakePageSpec[];
  /** omit markers entirely, whatever the options say */
  suppressMarkers?: boolean;
  hasEncodingIssues?: boolean;
  cmapGaps?: Array<{ font: string; codes: number; interpolated: number; unmapped: number }>;
  confidence?: number;
  /** throw this instead of returning, to exercise error paths */
  throws?: string;
  processingTimeMs?: number;
};

export const fakeMarker = (oneIndexedPage: number): string => `<!-- Page ${oneIndexedPage} -->`;

export class FakeInspector implements InspectorEngine {
  readonly calls: InspectorOptions[] = [];

  constructor(private readonly spec: FakeInspectorSpec) {}

  version(): string {
    return this.spec.version ?? "0.0.0-fake";
  }

  processPdf(_bytes: Uint8Array, options: InspectorOptions = {}): InspectorProcessResult {
    this.calls.push(options);
    if (this.spec.throws !== undefined) throw new Error(this.spec.throws);

    const pages = options.pages ?? this.spec.pages.map((_, i) => i + 1);
    if (pages.includes(0)) throw new Error("invalid options: pages are 1-indexed; page 0 is invalid");

    const pageCount = this.spec.pages.length;
    const withMarkers = options.includePageMarkers === true && this.spec.suppressMarkers !== true;
    const markdown = pages
      .map((p) => {
        const spec = this.spec.pages[p - 1];
        const body = spec?.markdown ?? "";
        return withMarkers ? `${fakeMarker(p)}\n${body}` : body;
      })
      .join("\n\n");

    const needs = this.spec.pages
      .map((s, i) => (s.needsOcr === true ? i + 1 : -1))
      .filter((p) => p > 0)
      .filter((p) => pages.includes(p));

    return {
      pdfType: this.spec.pdfType ?? "TextBased",
      markdown,
      pageCount,
      processingTimeMs: this.spec.processingTimeMs ?? 1,
      pagesNeedingOcr: needs,
      ocrReasonsByPage: needs
        .map((p) => ({ page: p, reasons: this.spec.pages[p - 1]?.ocrReasons ?? ["no text layer"] }))
        .filter((o) => o.reasons.length > 0),
      confidence: this.spec.confidence ?? 0.99,
      layout: { isComplex: false, pagesWithTables: [], pagesWithColumns: [] },
      hasEncodingIssues: this.spec.hasEncodingIssues ?? false,
      cmapGaps: this.spec.cmapGaps ?? [],
    };
  }

  classifyPdf(_bytes: Uint8Array): InspectorClassification {
    if (this.spec.throws !== undefined) throw new Error(this.spec.throws);
    return {
      pdfType: this.spec.pdfType ?? "TextBased",
      pageCount: this.spec.pages.length,
      // 0-indexed on purpose, matching the native API
      pagesNeedingOcr: this.spec.pages.map((s, i) => (s.needsOcr === true ? i : -1)).filter((p) => p >= 0),
      confidence: this.spec.confidence ?? 0.99,
    };
  }
}
