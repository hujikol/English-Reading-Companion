import { describe, expect, it } from "vitest";
import { planWindow } from "../../src/features/reader/pdf/windowing.ts";

/**
 * Two browser-reported defects pinned here.
 *
 * 1. Zoom only ever enlarged the canvas. The canvas bitmap was rendered at the
 *    bare device-pixel ratio, so it stayed the same size while its CSS box grew
 *    and the browser upscaled it — the page got bigger but never sharper.
 *    `renderScale` is the fix: zoom x DPR, capped.
 *
 * 2. Three pages were visible at once because the window is +-2 pages. Single
 *    page mode overrides the radius to 0.
 */
const base = {
  visiblePage: 10,
  pageCount: 100,
  tier: "desktop" as const,
  mounted: [],
  viewport: { widthCss: 612, heightCss: 792 },
  devicePixelRatio: 2,
  tabVisible: true,
  budgetBytes: 64 * 1024 * 1024,
};

describe("renderScale matches the CSS box at every zoom", () => {
  it("grows with zoom, so the bitmap is never upscaled", () => {
    const at = (zoom: number) => planWindow({ ...base, zoom, scrollDirection: 0 }).renderScale;
    expect(at(1)).toBeCloseTo(2, 5);
    expect(at(2)).toBeCloseTo(4, 5);
    expect(at(4)).toBeCloseTo(8, 5);
  });

  it("equals pxSize over the BASE width, so the bitmap grows with the box", () => {
    // Not pxSize/cssSize: both of those carry the zoom, so the quotient is
    // always DPR and the canvas never grows.
    const plan = planWindow({ ...base, zoom: 2, scrollDirection: 0 });
    expect(plan.renderScale).toBeCloseTo(plan.pxSize.width / base.viewport.widthCss, 5);
  });

  it("is capped, so a huge zoom cannot allocate an unbounded canvas", () => {
    const plan = planWindow({ ...base, zoom: 4, scrollDirection: 0, devicePixelRatio: 4 });
    expect(plan.pxSize.width).toBeLessThanOrEqual(8192);
  });
});

describe("single page mode", () => {
  it("mounts exactly the visible page when radius is 0", () => {
    expect(planWindow({ ...base, zoom: 1, radius: 0 }).keep).toEqual([10]);
  });

  it("still mounts the page holding a live selection", () => {
    // Selecting must not make the page under the reader's eyes vanish.
    const plan = planWindow({ ...base, zoom: 1, radius: 0, selectionPage: 12 });
    expect(plan.keep).toContain(10);
    expect(plan.keep).toContain(12);
  });

  it("keeps a window when continuous", () => {
    const plan = planWindow({ ...base, zoom: 1, scrollDirection: 0 });
    expect(plan.keep.length).toBeGreaterThan(1);
  });
});