import { describe, expect, it } from "vitest";
import { windowPages, planWindow } from "../../src/features/reader/pdf/windowing.ts";

/**
 * Continuous scrolling only feels continuous if the pages you are scrolling
 * TOWARD are mounted. A symmetric window evicts the near-forward pages under a
 * tight memory budget, so the reader scrolls into blank space.
 */
describe("windowPages: directional lead", () => {
  it("is symmetric when idle", () => {
    expect(windowPages(10, 100, 2)).toEqual([8, 9, 10, 11, 12]);
  });

  it("mounts further ahead when scrolling forward", () => {
    const forward = windowPages(10, 100, 2, [], 2);
    expect(forward).toContain(14); // ahead
    expect(forward).not.toContain(8); // behind, given up
    expect(forward).toContain(10);
  });

  it("mirrors when scrolling backward", () => {
    const backward = windowPages(10, 100, 2, [], -2);
    expect(backward).toContain(6);
    expect(backward).not.toContain(14);
  });

  it("never leaves the document", () => {
    expect(windowPages(0, 100, 2, [], 2).every((p) => p >= 0)).toBe(true);
    expect(windowPages(99, 100, 2, [], 2).every((p) => p < 100)).toBe(true);
  });

  it("keeps the same count as the symmetric window", () => {
    // A lead reallocates the budget; it must not grow the mounted set.
    expect(windowPages(10, 100, 2, [], 2)).toHaveLength(windowPages(10, 100, 2).length);
  });
});

describe("planWindow under a tight budget", () => {
  const base = {
    visiblePage: 10,
    pageCount: 100,
    tier: "desktop" as const,
    mounted: [],
    viewport: { widthCss: 612, heightCss: 792 },
    zoom: 1,
    devicePixelRatio: 2,
    tabVisible: true,
  };

  it("keeps the visible page no matter what", () => {
    const plan = planWindow({ ...base, budgetBytes: 1 });
    expect(plan.keep).toContain(10);
  });

  it("frees behind first when scrolling forward", () => {
    const budget = 40 * 1024 * 1024;
    const forward = planWindow({ ...base, budgetBytes: budget, scrollDirection: 1 });
    const backward = planWindow({ ...base, budgetBytes: budget, scrollDirection: -1 });
    // Forward scrolling should keep more pages ahead than behind.
    const aheadOf = (plan: typeof forward, v = 10) => plan.keep.filter((p) => p > v).length;
    const behindOf = (plan: typeof forward, v = 10) => plan.keep.filter((p) => p < v).length;
    expect(aheadOf(forward)).toBeGreaterThanOrEqual(behindOf(forward));
    expect(behindOf(backward)).toBeGreaterThanOrEqual(aheadOf(backward));
  });
});