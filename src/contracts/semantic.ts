/**
 * Semantic extraction contract. Owned by Track E, read by F and G.
 * Contains no geometry: the browser parser emits none and Tauri must not add it.
 */

export type ParserSource = "inspector-wasm" | "inspector-rust" | "pdfjs";
export type PageQuality = "usable" | "partial" | "unreliable" | "needs-ocr";
export type BlockKind = "paragraph" | "heading" | "list" | "table" | "unknown";

export type SemanticBlock = {
  id: string;
  kind: BlockKind;
  start: number;
  end: number;
};

export type SemanticPage = {
  cacheKey: string;
  documentId: string;
  pageIndex: number;
  parser: string;
  parserVersion: string;
  optionsHash: string;
  normalizerVersion: string;
  schemaVersion: number;
  text: string;
  blocks: SemanticBlock[];
  source: ParserSource;
  quality: PageQuality;
  warnings: string[];
  createdAt: number;
  lastAccessedAt: number;
};

/**
 * Worker messages from Section 14. Every request carries requestId, documentId
 * and generation; responses from an older generation are ignored.
 */
export type WorkerRequest =
  | { type: "OPEN"; requestId: string; documentId: string; generation: number; bytes: ArrayBuffer; password?: string }
  | { type: "CLASSIFY"; requestId: string; documentId: string; generation: number }
  | {
      type: "EXTRACT";
      requestId: string;
      documentId: string;
      generation: number;
      pageIndexes: number[];
      options?: Record<string, unknown>;
    }
  | { type: "CLOSE"; requestId: string; documentId: string; generation: number };

export type WorkerResponse =
  | { requestId: string; documentId: string; generation: number; ok: true; value: unknown }
  | { requestId: string; documentId: string; generation: number; ok: false; error: string };
