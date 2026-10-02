/**
 * Live selection capture. Reads the real DOM selection inside a mounted page's
 * text layer and turns it into a durable Anchor by calling
 * `features/selection/anchor.ts` — the normalization, offset mapping and
 * prefix/suffix context are NOT reimplemented here.
 *
 * Section 7: the selected text and its page identity are read from PDF.js
 * output; the viewport rectangle is captured for popover placement only and is
 * never part of the anchor, because nothing persisted may contain geometry.
 */

import type { Anchor } from "../../contracts/index.ts";
import { captureAnchor } from "../../features/selection/anchor.ts";

export type SelectionCapture = {
  quote: string;
  /** offsets of the quote inside the page's original text */
  startInPage: number;
  /** transient, for popover placement; never persisted */
  viewportRect?: { top: number; left: number; width: number; height: number } | undefined;
};

const isTextNode = (node: Node | null | undefined): node is Text => node !== null && node !== undefined && node.nodeType === 3;

/**
 * Character offset of (node, offset) within `container`, counting only text
 * nodes. PDF.js text layers are spans of text in reading order, so this is the
 * offset into the page text the engine reported.
 */
export function offsetInTextLayer(container: HTMLElement, node: Node, offset: number): number {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current = walker.nextNode();
  while (current !== null) {
    if (current === node) return total + offset;
    total += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
  // Not a descendant (e.g. a nested span's text was normalized): fall back to
  // the container's own length so capture stays total and never throws.
  return isTextNode(node) ? container.textContent?.length ?? 0 : total;
}

/** Read the current selection, restricted to one page's text layer element. */
export function readSelection(textLayer: HTMLElement): SelectionCapture | undefined {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!textLayer.contains(range.startContainer) || !textLayer.contains(range.endContainer)) return undefined;

  // The exact selected text, straight from the DOM. Not normalized: the quote
  // stays what the user selected.
  const quote = selection.toString();
  if (quote.trim().length === 0) return undefined;

  const start = offsetInTextLayer(textLayer, range.startContainer, range.startOffset);
  const end = offsetInTextLayer(textLayer, range.endContainer, range.endOffset);
  const rect = range.getBoundingClientRect();

  return {
    quote,
    startInPage: Math.min(start, end),
    viewportRect: rect.width === 0 && rect.height === 0 ? undefined : { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
  };
}

/**
 * Build the durable anchor. `pageText` is the page's original text from the
 * engine, which is what makes prefix/suffix and later re-anchoring possible.
 */
export function anchorFromSelection(capture: SelectionCapture, input: { pageIndex: number; pageFraction: number; pageText: string; now?: number }): Anchor {
  return captureAnchor({
    selectedText: capture.quote,
    pageIndex: input.pageIndex,
    pageFraction: input.pageFraction,
    pageText: input.pageText,
    startInPage: capture.startInPage,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

/** Which mounted page's text layer a selection node lives in. */
export function pageOfNode(node: Node | null, pageLayers: ReadonlyMap<HTMLElement, number>): number | undefined {
  if (node === null) return undefined;
  for (const [element, pageIndex] of pageLayers) if (element.contains(node)) return pageIndex;
  return undefined;
}
