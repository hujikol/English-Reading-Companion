/**
 * Reader model. Pure functions over the state the screen holds: no React, no
 * DOM, no Dexie. This is the layer worth testing, because it is where the
 * windowing policy, the progress locator and the scroll maths meet.
 *
 * Section 6 + Section 13: a Locator stores a PAGE and a scroll FRACTION of that
 * page. Nothing here measures or persists a rectangle.
 */

import type { Locator } from "../../contracts/index.ts";
import { cleanPageFraction, pageFractionOf } from "../../features/selection/anchor.ts";
import type { DeviceTier } from "../../features/library/validate.ts";
import { planWindow, type MountedPage, type Viewport, type WindowPlan } from "../../features/reader/pdf/windowing.ts";

/** Reader state the windowing policy needs, in one shape. */
export type ReaderLayoutState = {
  visiblePage: number;
  pageCount: number;
  tier: DeviceTier;
  mounted: readonly MountedPage[];
  /** base CSS size of one page, before zoom */
  viewport: Viewport;
  zoom: number;
  devicePixelRatio: number;
  inflight: readonly number[];
  /** page holding the live selection; pinned until the selection ends */
  selectionPage?: number | undefined;
  /** direction of travel; biases the window so scrolling stays continuous */
  scrollDirection?: -1 | 0 | 1 | undefined;
  tabVisible: boolean;
  budgetBytes?: number | undefined;
};

/**
 * Ask the existing policy what to mount, render, release and cancel. The reader
 * does not get a say: windowing.ts already encodes the Section 6 rules.
 */
export const planFor = (state: ReaderLayoutState): WindowPlan =>
  planWindow({
    visiblePage: state.visiblePage,
    pageCount: state.pageCount,
    tier: state.tier,
    mounted: state.mounted,
    viewport: state.viewport,
    zoom: state.zoom,
    devicePixelRatio: state.devicePixelRatio,
    inflight: state.inflight,
    tabVisible: state.tabVisible,
    ...(state.selectionPage === undefined ? {} : { selectionPage: state.selectionPage }),
    ...(state.budgetBytes === undefined ? {} : { budgetBytes: state.budgetBytes }),
  });

/** Zoom is capped so an unbounded canvas cannot be requested in the first place. */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 0.25;

export const clampZoom = (zoom: number): number => {
  const z = Number.isFinite(zoom) ? zoom : 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
};

/** Paging cannot run off either end of the document. */
export const stepPage = (page: number, delta: number, pageCount: number): number => {
  const max = Math.max(0, pageCount - 1);
  const next = Math.floor(page) + Math.trunc(delta);
  return next < 0 ? 0 : next > max ? max : next;
};

export type ScrollState = {
  scrollTop: number;
  /** CSS height of each mounted page, indexed by page */
  heights: ReadonlyMap<number, number>;
  /** pageTop of each mounted page in the scroll container */
  tops: ReadonlyMap<number, number>;
};

/**
 * Geometry of the page stack, derived rather than measured.
 *
 * The pages live in a flex column with a fixed gap and padding, so a page's top
 * is arithmetic: padding + index * (pageHeight + gap). Measuring each mounted
 * page with getBoundingClientRect() instead cannot see pages that are outside
 * the render window, so the reader could never scroll past the window — it read
 * as blank space, and page tops jumped as pages came and went. This also makes
 * a scroll frame O(1) instead of O(mounted pages).
 *
 * ponytail: assumes every page is the same height, which is what the reader
 * already assumed (page 0 seeds `baseSize` for all). Mixed-size PDFs will drift
 * out of step; measure real page sizes if one ever matters.
 */
export type StackGeometry = {
  pageCount: number;
  /** CSS height of one page box */
  pageHeight: number;
  /** gap between pages, matching the CSS */
  gap: number;
  /** the scroll container's top padding */
  padding: number;
};

export function stackState(geometry: StackGeometry, scrollTop: number): ScrollState {
  const { pageCount, pageHeight, gap, padding } = geometry;
  const stride = pageHeight + gap;
  const tops = new Map<number, number>();
  const heights = new Map<number, number>();
  for (let page = 0; page < pageCount; page++) {
    tops.set(page, padding + page * stride);
    heights.set(page, pageHeight);
  }
  return { scrollTop, tops, heights };
}

/** The page at the top of the viewport, or the first when scrolled above it. */
export function visiblePageOfState(state: ScrollState): number {
  if (state.tops.size === 0) return 0;
  let best = 0;
  let bestTop = -Infinity;
  for (const [page, top] of state.tops) if (top <= state.scrollTop + 1 && top > bestTop) {
    best = page;
    bestTop = top;
  }
  return best;
}

/** How far the viewport has scrolled INTO one page, as a 0..1 fraction. */
export function pageFractionAtState(state: ScrollState, page: number): number {
  const top = state.tops.get(page);
  const height = state.heights.get(page);
  if (top === undefined || height === undefined || height <= 0) return 0;
  return pageFractionOf(state.scrollTop - top, height);
}

/**
 * The page at the top of the viewport. Uses page tops, so it is correct whether
 * pages are mounted continuously or the windowing policy left gaps.
 */
export function visiblePageOf(state: ScrollState): number {
  let best = -1;
  let bestTop = -Infinity;
  for (const [page, top] of state.tops) if (top <= state.scrollTop + 1 && top > bestTop) {
    best = page;
    bestTop = top;
  }
  if (best >= 0) return best;
  // Above the first mounted page: fall back to the topmost one.
  let first = -1;
  let firstTop = Infinity;
  for (const [page, top] of state.tops) if (top < firstTop) {
    first = page;
    firstTop = top;
  }
  return first < 0 ? 0 : first;
}

/** How far the viewport has scrolled INTO one page, as a 0..1 fraction. */
export function pageFractionAt(state: ScrollState, page: number): number {
  const top = state.tops.get(page);
  const height = state.heights.get(page);
  if (top === undefined || height === undefined || height <= 0) return 0;
  return pageFractionOf(state.scrollTop - top, height);
}

/** Whole-document progression, 0..1, from the first to the last page. */
export function progressionAt(state: ScrollState, pageCount: number): number {
  if (pageCount <= 1) return 0;
  const total = (state.scrollTop - firstTopOf(state)) / Math.max(1, totalHeightOf(state));
  return total < 0 ? 0 : total > 1 ? 1 : total;
}

const firstTopOf = (state: ScrollState): number => Math.min(...state.tops.values(), 0);
const totalHeightOf = (state: ScrollState): number => {
  let max = 0;
  for (const [page, top] of state.tops) max = Math.max(max, top + (state.heights.get(page) ?? 0));
  return max;
};

/** The durable position for a page + scroll offset. Geometry-free by contract. */
export const locatorAt = (page: number, fraction: number): Locator => ({ kind: "pdf", pageIndex: page, pageFraction: cleanPageFraction(fraction) });

/** Restore a stored locator. A missing or foreign locator starts at page 1. */
export function locatorToPage(locator: Locator | undefined): { page: number; fraction: number } {
  if (locator === undefined || locator.kind !== "pdf") return { page: 0, fraction: 0 };
  return { page: Math.max(0, locator.pageIndex), fraction: cleanPageFraction(locator.pageFraction) };
}

/**
 * Where a stored fraction lands in scroll pixels: the fraction of the page
 * height, clamped, so a stale fraction cannot scroll past the end.
 */
export function scrollTopFor(page: number, fraction: number, state: ScrollState): number {
  const top = state.tops.get(page);
  const height = state.heights.get(page);
  if (top === undefined || height === undefined) return 0;
  return top + cleanPageFraction(fraction) * height;
}
