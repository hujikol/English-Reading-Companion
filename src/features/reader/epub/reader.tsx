/**
 * The reading surface's logic, DOM-free (IDEA.md s8).
 *
 * Navigation, labelling, restore and the selection -> Anchor bridge live here
 * so they can be tested without a browser, and so `EpubScreen.tsx` is left doing
 * nothing but wiring. The rule this module exists to enforce: a chapter is
 * identified by its `spineHref` and nothing else. No scroll offset, no page
 * fraction, no element rectangle ever reaches a locator, because a stored
 * position that depends on layout is a position that breaks when the reader
 * changes the font size.
 */

import type { Anchor, Locator } from "../../../contracts/index.ts";
import { chapterLabel, type EpubBook, type EpubChapter } from "./opf.ts";
import { sanitizedText, type FrameSelection } from "./renderer.tsx";
import { resolveQuote } from "../text/quote-resolve.ts";
import { contextAround } from "../../selection/anchor.ts";

export type ChapterPosition = {
  /** index into the reading order, not the spine */
  position: number;
  count: number;
  label: string;
  href: string;
};

/** Reading-order navigation. Never throws at the ends; it clamps. */
export function stepPosition(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  const next = current + delta;
  if (next < 0) return 0;
  if (next > count - 1) return count - 1;
  return next;
}

export function chapterAt(book: EpubBook | undefined, position: number): EpubChapter | undefined {
  const index = book?.readingOrder[position];
  return index === undefined ? undefined : book?.chapters[index];
}

/** `Chapter 3 of 12 — The Ferry` for the toolbar. Display only. */
export function chapterPosition(book: EpubBook | undefined, position: number): ChapterPosition | undefined {
  const chapter = chapterAt(book, position);
  if (chapter === undefined) return undefined;
  return { position, count: book?.readingOrder.length ?? 0, label: chapterLabel(chapter, position), href: chapter.spineHref };
}

/**
 * Reading position, 0..1, for the progress store.
 *
 * A chapter ratio, not a scroll position: reflowable text has no page to be a
 * fraction of, and a ratio computed from layout would move under the reader's
 * own font-size control.
 */
export function progressionOf(book: EpubBook | undefined, position: number): number {
  const count = book?.readingOrder.length ?? 0;
  if (count <= 1) return 0;
  return Math.min(1, Math.max(0, Math.round((position / (count - 1)) * 1e6) / 1e6));
}

/** Restore a stored locator. Returns the position, or null when it is gone. */
export function restorePosition(book: EpubBook | undefined, locator: Locator | undefined): number | null {
  if (book === undefined || locator === undefined || locator.kind !== "epub") return null;
  const position = book.readingOrder.findIndex((i) => book.chapters[i]?.spineHref === locator.spineHref);
  return position < 0 ? null : position;
}

export const locatorFor = (spineHref: string): Locator => ({ kind: "epub", spineHref });

/**
 * Build the durable Anchor from a live frame selection.
 *
 * Field for field the same shape the PDF path produces: the exact selected text
 * as `quote`, neighbouring characters as `prefix`/`suffix`, a format-native
 * `locator`, and an `anchorState` that claims "resolved" only when the quote was
 * actually located in the text the reader is showing. Marks, bookmarks and
 * occurrence rows consume `Anchor`, so a mark saved from an EPUB chapter is
 * indistinguishable in storage from one saved from a PDF page.
 *
 * The chapter text is the renderer's sanitized text unless the caller passes
 * the frame's own `textContent`; the DOM copy is preferred when it is available
 * because the selection offsets were measured against it.
 */
export function anchorFromFrameSelection(input: {
  selection: FrameSelection;
  spineHref: string;
  /** the text the offsets were measured against */
  chapterText: string;
  now?: number;
}): Anchor {
  const { selection } = input;
  const locator = locatorFor(input.spineHref);
  const start = selection.startInText;
  if (start < 0 || start + selection.quote.length > input.chapterText.length) {
    return { quote: selection.quote, locator, anchorState: "unresolved" };
  }
  if (input.chapterText.slice(start, start + selection.quote.length) !== selection.quote) {
    return { quote: selection.quote, locator, anchorState: "unresolved" };
  }
  const { prefix, suffix } = contextAround(input.chapterText, start, start + selection.quote.length);
  return {
    quote: selection.quote,
    prefix,
    suffix,
    locator,
    anchorState: "resolved",
    ...(input.now === undefined ? {} : { resolvedAt: input.now }),
  };
}

/**
 * Re-find a stored anchor in a chapter, and say plainly when it cannot be.
 *
 * Delegates to Track E's `resolveQuote`, so EPUB anchors re-anchor under exactly
 * the rules TXT and Markdown do, including typography folding. The returned
 * `spineHref` is the chapter the text was found in, which may differ from the
 * stored one — a quote that moved chapters is a position, not a failure.
 */
export function reanchor(input: {
  anchor: Anchor;
  /** chapter text keyed by spine href */
  textBySpine: ReadonlyMap<string, string>;
}): { state: "resolved"; spineHref: string; range: { start: number; end: number } } | { state: "unresolved"; reason: string } {
  const stored = input.anchor.locator;
  if (stored.kind !== "epub") return { state: "unresolved", reason: "not an epub locator" };
  const first = input.textBySpine.get(stored.spineHref);
  if (first !== undefined) {
    const result = resolveQuote(first, input.anchor);
    if (result.resolved) return { state: "resolved", spineHref: stored.spineHref, range: { start: result.start, end: result.end } };
  }
  for (const [spineHref, text] of input.textBySpine) {
    if (spineHref === stored.spineHref) continue;
    const result = resolveQuote(text, input.anchor);
    if (result.resolved) return { state: "resolved", spineHref, range: { start: result.start, end: result.end } };
  }
  return { state: "unresolved", reason: "the saved text no longer appears in this book" };
}

export { sanitizedText };

import type { OpenFailure } from "./adapter.ts";

export function openFailureMessage(failure: OpenFailure): string {
  if (failure.reason !== "unsupported") return "This file could not be opened as an EPUB.";
  switch (failure.unsupported.kind) {
    case "drm":
      return "This book is DRM-protected, so its text cannot be read here.";
    case "encrypted":
      return "This book is encrypted, so its text cannot be read here.";
    case "fixed-layout":
      return "This is a fixed-layout book. Only reflowable text books can be read in this version.";
    case "oversized":
      return failure.detail.includes("expansion")
        ? "This book is compressed in a way that indicates a decompression bomb, so it was not opened."
        : "This book is too large to open safely on this device.";
    case "zip":
      return "This book's archive contains unsafe file paths, so it was not opened.";
    case "needs-encoding":
      return "This chapter's text is not in a readable encoding.";
    default:
      return "This file could not be opened as an EPUB.";
  }
}
