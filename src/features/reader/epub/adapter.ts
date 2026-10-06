/**
 * Renderer adapter seam for reflowable formats (EPUB, TXT, Markdown).
 *
 * The interface is the contract Track A registers formats against and Track E
 * calls for quote-resolution hooks. Everything behind it is intentionally
 * absent: no epub.js import, no DOM. Real rendering plugs in here.
 *
 * s8 hard rules encoded in the interface:
 *  - no geometry anywhere (no bounding boxes, no scroll fractions to persist)
 *  - object URLs released on close, verified by the caller's own assertions
 *  - book scripting disabled: the adapter never enables `allow-scripts`
 */

import type { Anchor, Capabilities, Locator } from "../../../contracts/document.ts";
import type { ResolutionResult } from "../text/quote-resolve.ts";

export type SelectionEvent = {
  /** Exact selected text as it appears in the rendered DOM. */
  quote: string;
  prefix?: string;
  suffix?: string;
  locator: Locator;
  /** Transient, never persisted (s7). */
  viewportRect?: { top: number; left: number; width: number; height: number };
};

export type Appearance = {
  fontFamily: string;
  fontSizePx: number;
  lineHeight: number;
  /** Reader-controlled margin in px; not book CSS, not persisted as geometry. */
  marginPx: number;
  theme: "light" | "dark" | "sepia";
};

export const DEFAULT_APPEARANCE: Appearance = {
  fontFamily: "Georgia, serif",
  fontSizePx: 18,
  lineHeight: 1.6,
  marginPx: 24,
  theme: "light",
};

/** Formats this adapter refuses, reported explicitly rather than half-rendered
 * (s8: scope v0.1 to reflowable; report fixed-layout or DRM explicitly). */
export type Unsupported =
  | { kind: "fixed-layout" }
  | { kind: "drm"; detail: string }
  | { kind: "encrypted"; detail: string }
  | { kind: "zip"; detail: string }
  | { kind: "oversized"; detail: string }
  | { kind: "needs-encoding"; detail: string }
  | { kind: "damaged"; detail: string };

export type OpenFailure =
  | { ok: false; reason: "unsupported"; unsupported: Unsupported; detail: string }
  | { ok: false; reason: "too-many-locations"; detail: string };

export type ChapterRef = {
  spineHref: string;
  title?: string;
};

/**
 * One unit of navigable content. `text` is the sanitized plain text used for
 * quote resolution and context extraction (s8: reflowable formats derive
 * context from sanitized text nodes, not the PDF semantic parser).
 */
export type RenderedUnit =
  | { kind: "epub-section"; spineHref: string; sanitizedHtml: string; css: string; text: string }
  | { kind: "text-block"; blockId: string; sanitizedHtml: string; text: string; start: number; end: number }
  | { kind: "md-block"; blockId: string; sanitizedHtml: string; text: string; start: number; end: number };

export type RendererAdapter = {
  readonly format: "epub" | "txt" | "md";
  readonly capabilities: Capabilities;

  /**
   * Validate and open. MUST complete validation before anything renders, and
   * MUST return an `unsupported` failure rather than opening a damaged book.
   */
  open(bytes: Uint8Array): Promise<{ ok: true; documentId: string; chapters: ChapterRef[] } | OpenFailure>;

  /** Bounded indexing after opening (s8: build expensive location indexes
   * after opening, not before). */
  index(): Promise<void>;

  setAppearance(appearance: Appearance): void;
  getAppearance(): Appearance;

  /** Navigate by locator. Returns false when the locator no longer exists. */
  goTo(locator: Locator): boolean;
  current(): Locator;

  /** Unit the reader is currently showing — the text quote resolution runs
   * against. */
  currentUnit(): RenderedUnit | null;

  /** Resolve a stored anchor against current renderer text. Returns
   * `{resolved:false}` rather than guessing (s7, D1 exit). */
  resolveAnchor(anchor: Anchor): ResolutionResult;

  /** Full document text, for a document-level sweep when a per-unit resolve
   * fails. Expensive: callers should try units first. */
  documentText(): string;

  /** Emits on every selection change. The controller is the shared
   * selection controller, which Track A owns; this adapter only emits. */
  onSelection(listener: (event: SelectionEvent) => void): () => void;

  /** Releases object URLs, cancels pending work, detaches listeners. Idempotent. */
  close(): void;
};

/**
 * Object-URL lifetime guard. The adapter's `close()` must have revoked every
 * URL it created; this makes the obligation explicit and testable without a
 * DOM (tests supply a fake URL factory).
 */
export class AssetRegistry {
  #urls: string[] = [];
  readonly #create: (bytes: Uint8Array) => string;
  readonly #revoke: (url: string) => void;

  constructor(
    create: (bytes: Uint8Array) => string = (bytes) => `blob:asset/${bytes.byteLength}`,
    revoke: (url: string) => void = () => {},
  ) {
    this.#create = create;
    this.#revoke = revoke;
  }

  /** ponytail: no size accounting here; ZIP totals already bound the archive.
   * Add per-asset budgets when the asset manager exists. */
  register(bytes: Uint8Array): string {
    const url = this.#create(bytes);
    this.#urls.push(url);
    return url;
  }

  get size(): number {
    return this.#urls.length;
  }

  revokeAll(): void {
    for (const url of this.#urls) this.#revoke(url);
    this.#urls = [];
  }
}
