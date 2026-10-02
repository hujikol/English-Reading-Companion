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
  const from = Math.max(0, startInPage);
  // A generous window, then trimmed to sentence-ish boundaries. Cheap and
  // good enough: provenance is context for the learner, not a parser input.
  const windowStart = Math.max(0, from - 200);
  const windowEnd = Math.min(pageText.length, from + quote.length + 200);
  const slice = pageText.slice(windowStart, windowEnd).replace(/\s+/g, " ").trim();
  const relStart = from - windowStart;
  const stop = slice.indexOf(".", relStart);
  const stopBang = slice.indexOf("!", relStart);
  const stopQ = slice.indexOf("?", relStart);
  const candidates = [stop, stopBang, stopQ].filter((i): i is number => i >= relStart);
  if (candidates.length === 0) return slice;
  return slice.slice(0, Math.min(...candidates) + 1).trim();
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
