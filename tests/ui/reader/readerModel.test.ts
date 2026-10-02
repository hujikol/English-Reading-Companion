/**
 * The reader's model layer: what the windowing policy decides for the real
 * screen, and how a scroll position becomes a stored Locator.
 *
 * These are the parts where a bug is silent (a page released while its
 * selection is live, an unbounded canvas at high zoom, a progress write that
 * lands on the wrong page), so they are worth pinning down without a browser.
 */

import { describe, expect, it } from "vitest";
import type { Locator } from "../../../src/contracts/index.ts";
import { MAX_CANVAS_EDGE, MAX_DEVICE_PIXEL_RATIO } from "../../../src/features/reader/pdf/windowing.ts";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  locatorAt,
  locatorToPage,
  pageFractionAt,
  planFor,
  progressionAt,
  scrollTopFor,
  stepPage,
  visiblePageOf,
  type ScrollState,
} from "../../../src/ui/reader/readerModel.ts";
import { captureAnchor } from "../../../src/features/selection/anchor.ts";

const base = (over: Partial<Parameters<typeof planFor>[0]> = {}) => ({
  visiblePage: 5,
  pageCount: 40,
  tier: "desktop" as const,
  mounted: [] as { pageIndex: number; widthPx: number; heightPx: number }[],
  viewport: { widthCss: 720, heightCss: 960 },
  zoom: 1,
  devicePixelRatio: 2,
  inflight: [] as number[],
  tabVisible: true,
  ...over,
});

describe("the reader defers to the windowing policy", () => {
  it("keeps the visible page plus two each side on desktop", () => {
    expect(planFor(base()).keep).toEqual([3, 4, 5, 6, 7]);
  });

  it("keeps one each side on a phone", () => {
    // DPR 1 so the canvas budget is not the binding constraint here.
    expect(planFor(base({ tier: "phone", devicePixelRatio: 1 })).keep).toEqual([4, 5, 6]);
  });

  it("shrinks the window when canvas memory reaches the phone budget", () => {
    // At DPR 2 a 720x960 page costs ~11 MiB, so three of them blow the 24 MiB
    // phone budget. The policy must drop the farthest page rather than overrun.
    const tight = planFor(base({ tier: "phone", devicePixelRatio: 2 }));
    expect(tight.keep).toEqual([4, 5]);
    expect(tight.budgetBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
  });

  it("includes the page holding a live selection even when it is far away", () => {
    // The selection page is pinned by the policy; the reader must pass it in.
    expect(planFor(base({ selectionPage: 0 })).keep).toContain(0);
    expect(planFor(base({ selectionPage: 0 })).keep).toContain(5);
  });

  it("releases a mounted page the plan no longer keeps", () => {
    const mounted = [{ pageIndex: 1, widthPx: 100, heightPx: 100 }];
    expect(planFor(base({ mounted })).release).toEqual([1]);
  });

  it("cancels an in-flight render the plan no longer covers", () => {
    expect(planFor(base({ inflight: [0, 5] })).cancel).toEqual([0]);
  });

  it("pauses speculative work and keeps only the visible render when hidden", () => {
    const hidden = planFor(base({ tabVisible: false, inflight: [4, 5, 6] }));
    expect(hidden.paused).toBe(true);
    expect(hidden.render).toEqual([5]);
    expect(hidden.cancel).toEqual([4, 5, 6]);
  });
});

describe("zoom cannot allocate an unbounded canvas", () => {
  it("caps the effective scale at the policy's device-pixel limit", () => {
    const plan = planFor(base({ zoom: 4, devicePixelRatio: 3 }));
    expect(plan.scale).toBe(MAX_DEVICE_PIXEL_RATIO);
  });

  it("keeps every canvas edge inside the policy's cap", () => {
    const plan = planFor(base({ zoom: ZOOM_MAX, devicePixelRatio: 3 }));
    expect(plan.pxSize.width).toBeLessThanOrEqual(MAX_CANVAS_EDGE);
    expect(plan.pxSize.height).toBeLessThanOrEqual(MAX_CANVAS_EDGE);
  });

  it("clamps the zoom control itself, not just the canvas", () => {
    expect(clampZoom(99)).toBe(ZOOM_MAX);
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    // NaN zoom becomes 1, matching windowing.ts's own effectiveScale rule.
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(1.13)).toBe(1.13);
  });
});

describe("paging cannot run off either end", () => {
  it("clamps at the first and last page", () => {
    expect(stepPage(0, -1, 10)).toBe(0);
    expect(stepPage(9, 1, 10)).toBe(9);
    expect(stepPage(4, 1, 10)).toBe(5);
  });

  it("stays at page 1 for a zero-page document instead of going negative", () => {
    expect(stepPage(0, -1, 0)).toBe(0);
    expect(stepPage(0, 1, 0)).toBe(0);
  });
});

const scroll = (scrollTop: number, entries: [number, number][]): ScrollState => {
  const heights = new Map<number, number>();
  const tops = new Map<number, number>();
  let cursor = 0;
  for (const [page, height] of entries) {
    tops.set(page, cursor);
    heights.set(page, height);
    cursor += height + 16; // the flex gap
  }
  return { scrollTop, heights, tops };
};

describe("scroll position to page", () => {
  const state = scroll(0, [
    [0, 1000],
    [1, 1000],
    [2, 1000],
  ]);

  it("reports the page at the top of the viewport", () => {
    expect(visiblePageOf(state)).toBe(0);
    expect(visiblePageOf(scroll(1016, [[0, 1000], [1, 1000], [2, 1000]]))).toBe(1);
  });

  it("falls back to the topmost page when scrolled above every page", () => {
    expect(visiblePageOf({ scrollTop: -500, heights: state.heights, tops: state.tops })).toBe(0);
  });

  it("reports 0 when nothing is mounted", () => {
    expect(visiblePageOf({ scrollTop: 100, heights: new Map(), tops: new Map() })).toBe(0);
  });
});

describe("the stored locator is a page and a scroll fraction, never a rectangle", () => {
  it("stores no geometry", () => {
    const locator = locatorAt(4, 0.375);
    expect(locator).toEqual({ kind: "pdf", pageIndex: 4, pageFraction: 0.375 });
    expect(JSON.stringify(locator)).not.toMatch(/bbox|rect|top|left|width|height|coord/i);
  });

  it("clamps a fraction that came from a stale or hostile value", () => {
    expect(locatorAt(0, -3)).toEqual({ kind: "pdf", pageIndex: 0, pageFraction: 0 });
    expect(locatorAt(0, 9)).toEqual({ kind: "pdf", pageIndex: 0, pageFraction: 1 });
  });

  it("measures the scroll offset inside the page", () => {
    const state = scroll(500, [[0, 1000]]);
    expect(pageFractionAt(state, 0)).toBeCloseTo(0.5, 3);
  });

  it("is 0 for a page with no measured height rather than NaN", () => {
    expect(pageFractionAt({ scrollTop: 100, heights: new Map(), tops: new Map() }, 0)).toBe(0);
  });

  it("agrees with the anchor module's own fraction rule", () => {
    const state = scroll(1250, [[0, 1000], [1, 1000]]);
    const fraction = pageFractionAt(state, 1);
    expect(fraction).toBeCloseTo((1250 - 1016) / 1000, 3);
  });
});

describe("restoring a saved position", () => {
  const state = scroll(0, [
    [0, 1000],
    [1, 1000],
    [2, 1000],
  ]);

  it("reads a stored pdf locator", () => {
    expect(locatorToPage({ kind: "pdf", pageIndex: 2, pageFraction: 0.5 })).toEqual({ page: 2, fraction: 0.5 });
  });

  it("starts at page 1 for a missing or foreign locator", () => {
    expect(locatorToPage(undefined)).toEqual({ page: 0, fraction: 0 });
    expect(locatorToPage({ kind: "text", blockId: "b1", start: 0, end: 1 })).toEqual({ page: 0, fraction: 0 });
  });

  it("lands on the same line, not just the same page", () => {
    expect(scrollTopFor(1, 0.5, state)).toBeCloseTo(1016 + 500, 3);
  });

  it("round-trips: store a fraction, reopen at it", () => {
    const locator: Locator = locatorAt(1, 0.5);
    const restored = locatorToPage(locator);
    const pixels = scrollTopFor(restored.page, restored.fraction, state);
    const after = scroll(pixels, [
      [0, 1000],
      [1, 1000],
      [2, 1000],
    ]);
    expect(pageFractionAt(after, 1)).toBeCloseTo(0.5, 3);
  });
});

describe("whole-document progression", () => {
  it("is 0 at the first page and 1 at the end", () => {
    const entries: [number, number][] = [
      [0, 1000],
      [1, 1000],
    ];
    const state = scroll(0, entries);
    expect(progressionAt(state, 2)).toBeLessThan(0.1);
    const end = scroll(1016 + 1000, entries);
    expect(progressionAt(end, 2)).toBeGreaterThan(0.9);
  });

  it("is 0 for a single-page document", () => {
    expect(progressionAt(scroll(0, [[0, 1000]]), 1)).toBe(0);
  });
});

describe("a mark's anchor and the reader's locator agree", () => {
  it("produces the same locator shape the reader persists", () => {
    // captureAnchor is the source of truth for marks; locatorAt for progress and
    // bookmarks. If these drift, a mark and a bookmark on one page disagree.
    const anchor = captureAnchor({ selectedText: "hello", pageIndex: 3, pageFraction: 0.25, pageText: "well hello there" });
    expect(anchor.locator).toEqual(locatorAt(3, 0.25));
    expect(anchor.anchorState).toBe("resolved");
  });

  it("keeps an empty page fraction at 0 rather than storing NaN", () => {
    const anchor = captureAnchor({ selectedText: "x", pageIndex: 0, pageFraction: Number.NaN });
    expect(anchor.locator.kind === "pdf" && anchor.locator.pageFraction).toBe(0);
  });
});
