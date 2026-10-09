/**
 * The join between the two halves of the core loop.
 *
 * The reader captures a selection (`ui/reader/selection.ts`) and the popover
 * consumes a `Selection` (`ui/vocab/selectionPopover.ts`). Nothing connected
 * them, so selecting a word in a PDF produced no lookup at all. This module is
 * that missing adapter, kept pure and separate from both components so it can
 * be tested without a DOM.
 *
 * Two rules from the spec are load-bearing here:
 *  - the viewport rectangle is TRANSIENT. It positions the card and is never
 *    part of the Anchor, because nothing persisted may contain geometry.
 *  - the sentence is provenance, not the query. The dictionary is asked for the
 *    selected surface only; the sentence exists for the learner's own notes and
 *    for a future AI call, never to widen the lookup.
 */

import type { Anchor } from "../../contracts/index.ts";
import { anchorFromSelection, type SelectionCapture } from "./selection.ts";
import type { Selection } from "../vocab/selectionPopover.ts";

/** Sentence containing `startInPage`, for provenance. Best effort, never throws. */
export function sentenceAround(pageText: string, startInPage: number, quote: string): string {
  if (pageText === "") return quote;
  const from = Math.max(0, Math.min(pageText.length, startInPage));
  const through = Math.min(pageText.length, from + quote.length);
  // Keep complete sentences; provider limits reject long context rather than silently crop it.
  const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(pageText)];
  const start = sentences.find(part => part.index + part.segment.length > from)?.index ?? 0;
  const endPart = sentences.find(part => part.index + part.segment.length >= through);
  const end = endPart ? endPart.index + endPart.segment.length : pageText.length;
  return pageText.slice(start, end).replace(/\s+/g, " ").trim() || quote;
}

export type BuildSelectionInput = {
  capture: SelectionCapture;
  pageIndex: number;
  pageFraction: number;
  /** the page's original text from the engine; required for prefix/suffix */
  pageText: string;
  documentId: string;
  titleSnapshot: string;
  now?: number;
};

/**
 * Translate a live capture into the popover's `Selection`, or `undefined` when
 * there is nothing worth showing. A whitespace-only selection must not open a
 * card.
 */
export function buildSelection(input: BuildSelectionInput): Selection | undefined {
  const quote = input.capture.quote.trim();
  if (quote === "") return undefined;

  const anchor: Anchor = anchorFromSelection(input.capture, {
    pageIndex: input.pageIndex,
    pageFraction: input.pageFraction,
    pageText: input.pageText,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  // The card needs a rect to position against. Without one there is nowhere to
  // put it, so abstain rather than guessing a corner.
  const rect = input.capture.viewportRect;
  if (!rect) return undefined;

  return {
    surface: quote,
    sentence: sentenceAround(input.pageText, input.capture.startInPage, quote),
    anchor,
    documentId: input.documentId,
    titleSnapshot: input.titleSnapshot,
    rect: { top: rect.top, left: rect.left, bottom: rect.top + rect.height, right: rect.left + rect.width },
    positionLabel: `Page ${input.pageIndex + 1}`,
  };
}
