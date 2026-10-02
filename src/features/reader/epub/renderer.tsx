/**
 * The EPUB renderer: validate -> inflate -> sanitize -> mount (IDEA.md s8).
 *
 * The trust boundary is `zip-validate.ts` and it runs to completion BEFORE the
 * first byte is inflated. That ordering is the whole point of this module, so it
 * is worth stating precisely what it buys:
 *
 *  - `validateZip` reads the central directory only. It never allocates entry
 *    bytes, so a decompression bomb is rejected while the archive is still just
 *    a byte array.
 *  - Only then is `unzipSync` called, and only with a `filter` naming the one
 *    entry being rendered. fflate preallocates the DECLARED expanded size for
 *    each entry it inflates, and those declared sizes are exactly the ones
 *    `validateZip` bounded (100 MiB total, 100:1 ratio). A bomb that survived
 *    validation would therefore still be bounded, which is why there is no
 *    separate "unzip then check" step to forget.
 *  - The inflated length is measured again with `checkSectionLength` after the
 *    fact, because a section that inflates past the per-section ceiling is a
 *    memory problem even inside a legal archive.
 *
 * The frame is mounted with `chapterSandboxAttribute()` and the srcdoc built by
 * `chapterFramePolicy`, so publication scripts have no permission to run and the
 * CSP denies them even if a script element somehow survived sanitization.
 * `allow-same-origin` is the price of host-side selection integration and is
 * never combined with `allow-scripts` (s8).
 *
 * DOM-free by construction except for `EpubChapterFrame` and the selection
 * reader, so the whole engine is testable in Node.
 */

import { unzipSync } from "fflate";
import type { CSSProperties, ReactElement } from "react";
import type { Anchor, Capabilities, Locator } from "../../../contracts/index.ts";
import {
  EPUB_LIMITS,
  checkSectionLength,
  detectDrm,
  validateEpubContainer,
  validateZip,
  type ZipEntry,
  type ZipRejectReason,
} from "./zip-validate.ts";
import { sanitizeChapter, decodeEntities, type SanitizeCounters } from "./sanitize.ts";
import { chapterFramePolicy, type ChapterFramePolicy } from "./isolation.ts";
import { chapterCss, type ChapterCss } from "./css.ts";
import { chapterLabel, readEpub, type EpubBook, type EpubChapter } from "./opf.ts";
import { decodeAuto } from "../text/decode.ts";
import { resolveQuote, type ResolutionResult } from "../text/quote-resolve.ts";
import { contextAround } from "../../selection/anchor.ts";
import {
  AssetRegistry,
  DEFAULT_APPEARANCE,
  type Appearance,
  type ChapterRef,
  type OpenFailure,
  type RenderedUnit,
  type RendererAdapter,
  type SelectionEvent,
  type Unsupported,
} from "./adapter.ts";
import { newDocumentId } from "../../library/identity.ts";

/** Bound on the post-open text index, so a 10,000-entry book cannot stall the UI. */
export const INDEX_LIMITS = {
  maxChapters: 2_000,
  maxTextBytes: 32 * 1024 * 1024,
} as const;

/** Refuse a chapter longer than this many characters, independent of its bytes. */
export const MAX_CHAPTER_CHARS = 2_000_000;

/** A local asset may not exceed the per-section ceiling either. */
const MAX_ASSET_BYTES = EPUB_LIMITS.maxSectionBytes;

/** Which `Unsupported` bucket a ZIP rejection belongs in, and what to tell the user. */
const UNSUPPORTED_BY_REASON: Record<ZipRejectReason, { kind: Unsupported["kind"]; message: string }> = {
  "not-a-zip": { kind: "damaged", message: "This file is not a valid EPUB container." },
  "truncated-central-directory": { kind: "damaged", message: "This EPUB's table of contents is truncated or corrupt." },
  "entry-count": { kind: "oversized", message: "This EPUB contains too many files to open safely." },
  "compressed-bytes": { kind: "oversized", message: "This EPUB is too large to open on this device." },
  "expanded-bytes": { kind: "oversized", message: "This EPUB expands to more data than this device will open." },
  "section-bytes": { kind: "oversized", message: "One section of this EPUB is too large to open." },
  "expansion-ratio": { kind: "oversized", message: "This EPUB is compressed in a way that indicates a decompression bomb." },
  "path-traversal": { kind: "zip", message: "This EPUB contains a file path that escapes the archive and was refused." },
  "absolute-path": { kind: "zip", message: "This EPUB contains an absolute file path and was refused." },
  "invalid-name": { kind: "zip", message: "This EPUB contains an unusable file name and was refused." },
  encrypted: { kind: "encrypted", message: "This EPUB is encrypted or DRM-protected." },
  "unsupported-method": { kind: "damaged", message: "This EPUB uses a compression method this reader does not support." },
};

/** MIME type for a local asset, from the manifest when it is known. */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  otf: "font/otf",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
};

export type EpubSectionFailure = { ok: false; reason: Unsupported["kind"] | "damaged"; detail: string };

export type RenderedChapter =
  | {
      ok: true;
      chapter: EpubChapter;
      /** markup already rebuilt from the sanitizer's allowlist */
      sanitizedHtml: string;
      /** plain text of that markup; the unit quote resolution runs against */
      text: string;
      /** sandbox + CSP + srcdoc, ready to hand to an <iframe> */
      frame: ChapterFramePolicy;
      counters: SanitizeCounters;
      css: ChapterCss;
    }
  | EpubSectionFailure;

export type EpubRendererDeps = {
  /** Injected so tests can count object URLs and assert revocation. */
  createObjectUrl?: (bytes: Uint8Array, mime: string) => string;
  revokeObjectUrl?: (url: string) => void;
  documentId?: string;
};

/** A copy into a plain ArrayBuffer: `Blob` rejects a `Uint8Array` view whose
 *  buffer might be a SharedArrayBuffer, and fflate hands us exactly that type. */
const blobPartOf = (bytes: Uint8Array): ArrayBuffer =>
  Uint8Array.from(bytes).buffer as ArrayBuffer;

const defaultCreate = (bytes: Uint8Array, mime: string): string => URL.createObjectURL(new Blob([blobPartOf(bytes)], { type: mime }));
const defaultRevoke = (url: string): void => URL.revokeObjectURL(url);

/**
 * Chapter text as the browser will see it.
 *
 * The sanitizer rebuilt this markup from an allowlist, so every `<...>` in it is
 * a tag it emitted and everything between them is escaped text. Stripping the
 * tags and decoding entities therefore reproduces `body.textContent` exactly,
 * which is what keeps a headless anchor and a mounted-frame anchor the same
 * anchor. If the sanitizer ever emits raw text unescaped this stops being true,
 * so the DOM copy is still preferred when a frame is mounted.
 */
export function sanitizedText(sanitizedHtml: string): string {
  return decodeEntities(sanitizedHtml.replace(/<[^>]*>/g, ""));
}


/** Archive-relative resolution used for chapter assets. Same rules as `opf.ts`. */
function resolveInArchive(base: string, href: string): string | null {
  const clean = href.split("#")[0] ?? "";
  if (clean === "" || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(clean) || clean.startsWith("//")) return null;
  const segments = (base === "" ? [] : base.split("/").slice(0, -1)).concat(clean.split("/"));
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/") || null;
}

const mimeFor = (path: string, book: EpubBook): string => {
  for (const item of Object.values(book.manifest)) if (item.href === path && item.mediaType !== "") return item.mediaType;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
};

/**
 * The EPUB renderer adapter.
 *
 * Holds the archive bytes for the lifetime of the document and inflates one
 * section at a time. `close()` revokes every object URL it minted; the registry
 * is the ledger that makes that obligation checkable.
 */
export class EpubRenderer implements RendererAdapter {
  readonly format = "epub" as const;
  readonly capabilities: Capabilities = { semantic: "unavailable", password: false, ocr: false, positionedText: false };

  #bytes: Uint8Array | undefined;
  #entries = new Map<string, ZipEntry>();
  #book: EpubBook | undefined;
  #assets: AssetRegistry;
  #assetUrls = new Map<string, string>();
  #appearance: Appearance = DEFAULT_APPEARANCE;
  #documentId = "";
  #current: EpubChapter | undefined;
  #rendered: RenderedChapter | undefined;
  #index = new Map<string, string>();
  #indexComplete = false;
  #listeners = new Set<(event: SelectionEvent) => void>();
  #closed = false;
  /**
   * How many times a section was actually handed to the inflater.
   *
   * This is the observable that makes the ordering claim in this file's header
   * testable: a rejected archive must leave it at zero, which is a stronger
   * statement than "the error message mentioned a bomb".
   */
  #inflateCalls = 0;
  /** MIME for the entry currently being minted; `AssetRegistry.register` takes
   *  bytes only, so the type is handed over through this one-slot channel
   *  rather than by forking Track D's registry. */
  #pendingMime = "application/octet-stream";

  constructor(deps: EpubRendererDeps = {}) {
    this.#assets = new AssetRegistry((bytes) => {
      const mime = this.#pendingMime;
      this.#pendingMime = "application/octet-stream";
      return (deps.createObjectUrl ?? defaultCreate)(bytes, mime);
    }, deps.revokeObjectUrl ?? defaultRevoke);
    this.#documentId = deps.documentId ?? newDocumentId();
  }

  /** Number of object URLs currently outstanding. Must be 0 after `close()`. */
  get liveAssetUrls(): number {
    return this.#assets.size;
  }

  /** Sections handed to fflate since construction. See `#inflateCalls`. */
  get inflateCalls(): number {
    return this.#inflateCalls;
  }

  get book(): EpubBook | undefined {
    return this.#book;
  }

  get documentId(): string {
    return this.#documentId;
  }

  get chapters(): ChapterRef[] {
    const book = this.#book;
    if (book === undefined) return [];
    return book.readingOrder.map((i) => {
      const chapter = book.chapters[i];
      if (chapter === undefined) throw new Error("reading order points outside the spine");
      return { spineHref: chapter.spineHref, title: chapterLabel(chapter, i) };
    });
  }

  /**
   * Validate, then open. Validation is total before anything is inflated, and
   * every failure is reported as `unsupported` with a reason rather than a
   * half-opened book.
   */
  async open(bytes: Uint8Array): Promise<{ ok: true; documentId: string; chapters: ChapterRef[] } | OpenFailure> {
    const fail = (reason: ZipRejectReason, detail: string): OpenFailure => {
      const bucket = UNSUPPORTED_BY_REASON[reason];
      return { ok: false, reason: "unsupported", unsupported: { kind: bucket.kind, detail }, detail: `${reason}: ${detail}` };
    };

    const zip = validateZip(bytes);
    if (!zip.ok) return fail(zip.reason, zip.detail);

    // Container-level, in two steps so DRM and a password-encrypted entry are
    // reported as different problems. Both run on the already-validated entry
    // list, so no entry is inflated to reach this verdict.
    const drm = detectDrm(zip.entries);
    if (!drm.ok) {
      return {
        ok: false,
        reason: "unsupported",
        unsupported: { kind: "drm", detail: drm.detail },
        detail: `encrypted: ${drm.detail}`,
      };
    }
    const container = validateEpubContainer(zip);
    if (!container.ok) return fail(container.reason, container.detail);

    for (const entry of zip.entries) this.#entries.set(entry.name, entry);
    const entryNames = new Set(this.#entries.keys());
    this.#bytes = bytes;

    const containerXml = this.#readText("META-INF/container.xml");
    if (containerXml === null) return fail("invalid-name", "META-INF/container.xml could not be read");

    const read = readEpub({ containerXml, readText: (path) => this.#readText(path), entryNames });
    if (!read.ok) {
      const kind = read.reason === "fixed-layout" ? "fixed-layout" : "damaged";
      return { ok: false, reason: "unsupported", unsupported: { kind, detail: read.detail }, detail: read.detail };
    }

    this.#book = read.book;
    return { ok: true, documentId: this.#documentId, chapters: this.chapters };
  }

  /**
   * Bounded text index, built AFTER opening (s8). Only sanitized text is kept,
   * because that is all quote resolution is allowed to see, and the walk stops
   * at the chapter/byte budget so a pathological book cannot stall the reader.
   */
  async index(): Promise<void> {
    const book = this.#book;
    if (book === undefined) return;
    let bytes = 0;
    let count = 0;
    for (const i of book.readingOrder) {
      if (count >= INDEX_LIMITS.maxChapters || bytes >= INDEX_LIMITS.maxTextBytes) {
        this.#indexComplete = false;
        return;
      }
      const chapter = book.chapters[i];
      if (chapter === undefined) continue;
      const text = this.#chapterText(chapter);
      if (text === null) continue;
      this.#index.set(chapter.spineHref, text);
      bytes += text.length;
      count += 1;
    }
    this.#indexComplete = true;
  }

  /** True when `index()` covered the whole reading order. A sweep that is not
   *  complete may report `no-match` for text it never read. */
  get indexIsComplete(): boolean {
    return this.#indexComplete;
  }

  setAppearance(appearance: Appearance): void {
    this.#appearance = appearance;
    this.#rerender();
  }

  /** Re-render the chapter on screen with the current appearance. */
  rerenderCurrent(): RenderedChapter | undefined {
    return this.#current === undefined ? undefined : this.#rerender();
  }

  #rerender(): RenderedChapter | undefined {
    const chapter = this.#current;
    if (chapter === undefined || this.#closed) return undefined;
    this.#rendered = this.#render(chapter);
    return this.#rendered;
  }

  getAppearance(): Appearance {
    return this.#appearance;
  }

  goTo(locator: Locator): boolean {
    if (locator.kind !== "epub") return false;
    const chapter = this.#chapterBySpineHref(locator.spineHref);
    if (chapter === undefined) return false;
    this.#current = chapter;
    this.#rendered = this.#render(chapter);
    return true;
  }

  current(): Locator {
    const chapter = this.#current ?? this.#book?.chapters[this.#book.readingOrder[0] ?? 0];
    if (chapter === undefined) throw new Error("no chapter is open");
    return { kind: "epub", spineHref: chapter.spineHref };
  }

  currentUnit(): RenderedUnit | null {
    const rendered = this.#rendered;
    if (rendered === undefined || !rendered.ok) return null;
    return {
      kind: "epub-section",
      spineHref: rendered.chapter.spineHref,
      sanitizedHtml: rendered.sanitizedHtml,
      css: rendered.css.css,
      text: rendered.text,
    };
  }

  /**
   * Resolve a stored anchor against the text the reader is actually showing.
   * Abstains rather than guessing, exactly like the PDF path.
   */
  resolveAnchor(anchor: Anchor): ResolutionResult {
    const text = this.#rendered?.ok === true ? this.#rendered.text : "";
    return resolveQuote(text, anchor);
  }

  /** Whole-document text for the sweep that runs when a unit resolve fails. */
  documentText(): string {
    if (this.#index.size === 0) void this.index();
    const book = this.#book;
    if (book === undefined) return "";
    const parts: string[] = [];
    for (const i of book.readingOrder) {
      const chapter = book.chapters[i];
      if (chapter === undefined) continue;
      const text = this.#index.get(chapter.spineHref) ?? this.#chapterText(chapter);
      if (text !== null) parts.push(text);
    }
    return parts.join("\n\n");
  }

  onSelection(listener: (event: SelectionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    this.#closed = true;
    this.#assets.revokeAll();
    this.#assetUrls.clear();
    this.#listeners.clear();
    this.#index.clear();
    this.#rendered = undefined;
    this.#current = undefined;
    this.#book = undefined;
    this.#entries.clear();
    this.#bytes = undefined;
  }

  // ---- rendering ----------------------------------------------------------

  /** Render the chapter at this spine index, or report why it cannot render. */
  renderIndex(position: number): RenderedChapter {
    const book = this.#book;
    if (book === undefined) return { ok: false, reason: "damaged", detail: "no book is open" };
    const chapter = book.chapters[book.readingOrder[position] ?? -1];
    if (chapter === undefined) return { ok: false, reason: "damaged", detail: `no chapter at position ${position}` };
    this.#current = chapter;
    this.#rendered = this.#render(chapter);
    return this.#rendered;
  }

  /** Render one chapter by spine href. */
  renderSpine(spineHref: string): RenderedChapter {
    const chapter = this.#chapterBySpineHref(spineHref);
    if (chapter === undefined) return { ok: false, reason: "damaged", detail: `unknown spine item: ${spineHref}` };
    this.#current = chapter;
    this.#rendered = this.#render(chapter);
    return this.#rendered;
  }

  /**
   * Turn a selection into the durable Anchor.
   *
   * The shape is the PDF path's shape, field for field: `quote` is the exact
   * selected text, `prefix`/`suffix` are the neighbouring characters of the
   * chapter's text, and the locator is format-native. `anchorState` is
   * "resolved" only when the selection's offsets actually locate the quote in
   * the chapter text, which is the same condition `captureAnchor` uses for a
   * PDF page. Nothing about the frame's geometry is stored.
   */
  anchorForSelection(input: { quote: string; startInText: number; spineHref: string; now?: number }): Anchor {
    const locator: Locator = { kind: "epub", spineHref: input.spineHref };
    const chapterText = this.#chapterTextBySpine(input.spineHref) ?? "";
    const { quote } = input;
    if (quote === "" || input.startInText < 0 || input.startInText + quote.length > chapterText.length) {
      return { quote, locator, anchorState: "unresolved" };
    }
    if (chapterText.slice(input.startInText, input.startInText + quote.length) !== quote) {
      return { quote, locator, anchorState: "unresolved" };
    }
    const { prefix, suffix } = contextAround(chapterText, input.startInText, input.startInText + quote.length);
    return {
      quote,
      prefix,
      suffix,
      locator,
      anchorState: "resolved",
      ...(input.now === undefined ? {} : { resolvedAt: input.now }),
    };
  }

  /** Publish a selection event to the shared controller. */
  publishSelection(event: SelectionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #render(chapter: EpubChapter): RenderedChapter {
    const raw = this.#readBytes(chapter.spineHref);
    if (raw === null) return { ok: false, reason: "damaged", detail: `chapter missing from the archive: ${chapter.spineHref}` };
    const section = checkSectionLength(raw.byteLength);
    if (!section.ok) return { ok: false, reason: "oversized", detail: section.detail };
    const decoded = decodeAuto(raw);
    if (!decoded.ok) return { ok: false, reason: decoded.reason === "too-large" ? "oversized" : "needs-encoding", detail: decoded.detail };

    const book = this.#book;
    if (book === undefined) return { ok: false, reason: "damaged", detail: "no book is open" };

    // CSS is gathered from the RAW chapter: `sanitizeChapter` drops <link>, so
    // reading it afterwards would lose every chapter-local stylesheet.
    const css = chapterCss({
      book,
      chapter,
      chapterXhtml: decoded.text,
      readText: (path) => this.#readText(path),
      entryNames: new Set(this.#entries.keys()),
      resolveAsset: (path) => this.#assetUrl(path),
      appearance: this.#appearance,
    });

    const sanitized = sanitizeChapter(decoded.text, {
      maxChars: MAX_CHAPTER_CHARS,
      resolveResource: (href) => {
        const path = resolveInArchive(chapter.spineHref, href);
        return path === null ? null : this.#assetUrl(path);
      },
    });
    if (!sanitized.ok) return { ok: false, reason: "oversized", detail: sanitized.detail };

    return {
      ok: true,
      chapter,
      sanitizedHtml: sanitized.html,
      text: sanitizedText(sanitized.html),
      frame: chapterFramePolicy(sanitized.html, css.css),
      counters: sanitized.counters,
      css,
    };
  }

  #chapterBySpineHref(spineHref: string): EpubChapter | undefined {
    return this.#book?.chapters.find((c) => c.spineHref === spineHref);
  }

  #chapterTextBySpine(spineHref: string): string | null {
    if (this.#rendered?.ok === true && this.#rendered.chapter.spineHref === spineHref) return this.#rendered.text;
    return this.#index.get(spineHref) ?? this.#chapterTextByRendering(spineHref);
  }

  #chapterText(chapter: EpubChapter): string | null {
    return this.#chapterTextByRendering(chapter.spineHref);
  }

  /** Sanitize a chapter for its text alone, without building a frame. */
  #chapterTextByRendering(spineHref: string): string | null {
    const raw = this.#readBytes(spineHref);
    if (raw === null) return null;
    if (!checkSectionLength(raw.byteLength).ok) return null;
    const decoded = decodeAuto(raw);
    if (!decoded.ok) return null;
    const sanitized = sanitizeChapter(decoded.text, { maxChars: MAX_CHAPTER_CHARS, resolveResource: () => null });
    if (!sanitized.ok) return null;
    return sanitizedText(sanitized.html);
  }

  /** Inflate exactly one entry, with the per-section budget applied after. */
  #readBytes(path: string): Uint8Array | null {
    const bytes = this.#bytes;
    if (bytes === undefined) return null;
    const entry = this.#entries.get(path);
    if (entry === undefined || entry.directory) return null;
    // Pre-check the declared size too: fflate allocates the declared expanded
    // length before inflating, so an oversized section must not reach it.
    if (!checkSectionLength(entry.expandedBytes).ok) return null;
    let files: Record<string, Uint8Array>;
    try {
      this.#inflateCalls += 1;
      files = unzipSync(bytes, { filter: (file) => file.name === path });
    } catch {
      return null;
    }
    const out = files[path];
    if (out === undefined) return null;
    return checkSectionLength(out.byteLength).ok ? out : null;
  }

  #readText(path: string): string | null {
    const raw = this.#readBytes(path);
    if (raw === null) return null;
    const decoded = decodeAuto(raw);
    return decoded.ok ? decoded.text : null;
  }

  /**
   * Mint (once) a blob URL for a validated local asset. Returns null for
   * anything not in the entry set, over budget, or already revoked.
   */
  #assetUrl(path: string): string | null {
    if (this.#closed) return null;
    const cached = this.#assetUrls.get(path);
    if (cached !== undefined) return cached;
    if (!this.#entries.has(path)) return null;
    const raw = this.#readBytes(path);
    if (raw === null || raw.byteLength > MAX_ASSET_BYTES) return null;
    const book = this.#book;
    if (book === undefined) return null;
    this.#pendingMime = mimeFor(path, book);
    const url = this.#assets.register(raw);
    this.#pendingMime = "application/octet-stream";
    this.#assetUrls.set(path, url);
    return url;
  }
}

// ---------------------------------------------------------------------------
// The mounted frame
// ---------------------------------------------------------------------------

/**
 * The chapter iframe.
 *
 * `sandbox` is the exact token list from `isolation.ts` — `allow-same-origin`
 * and nothing else. It is passed as a plain string rather than spread from a
 * list so there is no code path that could append `allow-scripts` later, and
 * `srcDoc` is the only channel book content travels through: there is no
 * `dangerouslySetInnerHTML` anywhere in the reader, so the sanitized markup can
 * never be parsed by the HOST document's parser, where the app's own CSP and
 * origin apply.
 */
export function EpubChapterFrame(props: {
  frame: ChapterFramePolicy;
  title: string;
  className?: string;
  style?: CSSProperties;
  onFrame?: (frame: HTMLIFrameElement | null) => void;
}): ReactElement {
  const ref = (element: HTMLIFrameElement | null): void => {
    props.onFrame?.(element);
  };
  return (
    <iframe
      ref={ref}
      className={props.className}
      style={props.style}
      title={props.title}
      sandbox={props.frame.sandbox}
      srcDoc={props.frame.srcdoc}
      referrerPolicy="no-referrer"
      loading="eager"
    />
  );
}

export type FrameSelection = {
  /** the selection's text, straight from the frame's DOM */
  quote: string;
  /** offset of that text in the frame's `body.textContent` */
  startInText: number;
  /** transient, for popover placement only; never persisted (s7) */
  viewportRect?: { top: number; left: number; width: number; height: number };
};

/**
 * Read the live selection out of a mounted chapter frame.
 *
 * The frame is same-origin (that is what `allow-same-origin` buys), so the host
 * can walk its text nodes. The frame's own scripts cannot run, so nothing in it
 * can lie about what it contains or reach back into the app. The offset is
 * measured against the DOM the reader is actually looking at, which is the same
 * discipline the PDF path uses against PDF.js text items.
 */
export function readFrameSelection(frame: HTMLIFrameElement | null): FrameSelection | undefined {
  const doc = frame?.contentDocument ?? null;
  const view = frame?.contentWindow ?? null;
  if (doc === null || view === null || doc.body === null) return undefined;
  const selection = view.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!doc.body.contains(range.startContainer) || !doc.body.contains(range.endContainer)) return undefined;

  const quote = selection.toString();
  if (quote.trim().length === 0) return undefined;

  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  let total = 0;
  let node = walker.nextNode();
  while (node !== null) {
    if (node === range.startContainer) {
      const rect = range.getBoundingClientRect();
      const viewportRect =
        rect.width === 0 && rect.height === 0
          ? undefined
          : { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
      return {
        quote,
        startInText: total + range.startOffset,
        ...(viewportRect === undefined ? {} : { viewportRect }),
      };
    }
    total += node.textContent?.length ?? 0;
    node = walker.nextNode();
  }
  return undefined;
}
