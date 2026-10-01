import { describe, expect, it } from "vitest";
import {
  CANVAS_BUDGET_BYTES,
  MAX_CANVAS_EDGE,
  MAX_DEVICE_PIXEL_RATIO,
  canvasBytes,
  cancelAllForZoom,
  effectiveScale,
  planWindow,
  releasedBytes,
  windowPages,
  type WindowInput,
} from "../../src/features/reader/pdf/windowing.ts";
import { classifyPdfOpenError, PdfPasswordRequiredError, PdfUnavailableError, unavailablePdfAdapter } from "../../src/features/reader/pdf/adapter.ts";

const base = (over: Partial<WindowInput> = {}): WindowInput => ({
  visiblePage: 10,
  pageCount: 100,
  tier: "desktop",
  mounted: [],
  viewport: { widthCss: 800, heightCss: 1000 },
  zoom: 1,
  devicePixelRatio: 1,
  tabVisible: true,
  ...over,
});

describe("window shape", () => {
  it("keeps visible plus two pages each side on desktop", () => {
    expect(windowPages(10, 100, 2)).toEqual([8, 9, 10, 11, 12]);
  });

  it("keeps visible plus one page each side on phones", () => {
    expect(planWindow(base({ tier: "phone" })).keep).toEqual([9, 10, 11]);
  });

  it("clamps at both document edges", () => {
    expect(windowPages(0, 5, 2)).toEqual([0, 1, 2]);
    expect(windowPages(4, 5, 2)).toEqual([2, 3, 4]);
  });

  it("clamps an out-of-range visible page instead of returning nothing", () => {
    expect(planWindow(base({ visiblePage: 999 })).keep).toContain(99);
    expect(planWindow(base({ visiblePage: -5 })).keep).toEqual([0, 1, 2]);
  });

  it("returns nothing for a zero-page document", () => {
    expect(planWindow(base({ pageCount: 0 })).keep).toEqual([]);
  });

  it("always includes the visible page", () => {
    expect(planWindow(base({ visiblePage: 42 })).keep).toContain(42);
  });
});

describe("zoom cannot allocate an unbounded canvas", () => {
  it("caps effective device-pixel scaling", () => {
    expect(effectiveScale(1, 1)).toBe(1);
    expect(effectiveScale(2, 2)).toBe(MAX_DEVICE_PIXEL_RATIO);
    expect(effectiveScale(8, 3)).toBe(MAX_DEVICE_PIXEL_RATIO);
  });

  it("treats a zero or negative zoom as 1", () => {
    expect(effectiveScale(0, 2)).toBe(2);
    expect(effectiveScale(Number.NaN, 1)).toBe(1);
    expect(effectiveScale(1.5, 0)).toBe(1.5);
  });

  it("caps individual canvas edges", () => {
    const p = planWindow(base({ zoom: 100, devicePixelRatio: 3 }));
    expect(p.pxSize.width).toBeLessThanOrEqual(MAX_CANVAS_EDGE);
    expect(p.pxSize.height).toBeLessThanOrEqual(MAX_CANVAS_EDGE);
  });

  it("reports the capped scale, not the requested one", () => {
    const p = planWindow(base({ zoom: 4, devicePixelRatio: 2 }));
    expect(p.scale).toBe(MAX_DEVICE_PIXEL_RATIO);
  });

  it("scales pixel size linearly with zoom, not quadratically", () => {
    const one = planWindow(base({ zoom: 1, devicePixelRatio: 1 }));
    const two = planWindow(base({ zoom: 2, devicePixelRatio: 1 }));
    expect(two.pxSize.width).toBe(one.pxSize.width * 2);
    expect(two.pxSize.height).toBe(one.pxSize.height * 2);
    // zoom scales both axes, so area is 4x and bytes are 4x — not the 16x that a
    // second zoom multiplication inside the pixel scale would produce
    expect(two.budgetBytes).toBe(one.budgetBytes * 4);
  });
});

describe("memory budget", () => {
  it("fits the desktop window inside the desktop budget at 1x", () => {
    const p = planWindow(base());
    expect(p.keep).toHaveLength(5);
    expect(p.budgetBytes).toBeLessThanOrEqual(CANVAS_BUDGET_BYTES.desktop);
  });

  it("shrinks the window when the budget cannot hold it", () => {
    const perPage = canvasBytes(800, 1000);
    const p = planWindow(base({ budgetBytes: perPage * 3 }));
    expect(p.keep).toHaveLength(3);
    expect(p.budgetBytes).toBeLessThanOrEqual(perPage * 3);
  });

  it("shrinks to a single page when only one fits", () => {
    const perPage = canvasBytes(800, 1000);
    expect(planWindow(base({ budgetBytes: perPage * 1 })).keep).toEqual([10]);
  });

  it("never drops the visible page, even below one page of budget", () => {
    const p = planWindow(base({ budgetBytes: 1 }));
    expect(p.keep).toEqual([10]);
  });

  it("drops one of the two farthest pages, keeping the visible page", () => {
    const perPage = canvasBytes(800, 1000);
    const p = planWindow(base({ budgetBytes: perPage * 4 }));
    expect(p.keep).toHaveLength(4);
    expect(p.keep).toContain(10);
    // 8 and 12 are equidistant; only one may survive at radius 1
    expect([8, 12].filter((x) => p.keep.includes(x))).toHaveLength(1);
  });

  it("keeps a page beyond the window when a selection is active there", () => {
    const p = planWindow(base({ selectionPage: 30 }));
    expect(p.keep).toContain(30);
    expect(p.keep).toEqual([8, 9, 10, 11, 12, 30]);
  });

  it("keeps the selection page even under a one-page budget", () => {
    const p = planWindow(base({ budgetBytes: 1, selectionPage: 30 }));
    expect(p.keep).toEqual([10, 30]);
  });

  it("releases the selection page once selection ends", () => {
    const before = planWindow(base({ selectionPage: 30, mounted: [{ pageIndex: 30, widthPx: 800, heightPx: 1000 }] }));
    expect(before.release).toEqual([]);
    const after = planWindow(base({ mounted: [{ pageIndex: 30, widthPx: 800, heightPx: 1000 }] }));
    expect(after.release).toEqual([30]);
  });
});

describe("cancel and pause", () => {
  it("cancels inflight tasks outside the keep set", () => {
    const p = planWindow(base({ inflight: [9, 40] }));
    expect(p.cancel).toEqual([40]);
  });

  it("keeps inflight tasks inside the keep set", () => {
    expect(planWindow(base({ inflight: [9, 10, 11] })).cancel).toEqual([]);
  });

  it("pauses speculative work and cancels everything when the tab is hidden", () => {
    const p = planWindow(base({ tabVisible: false, inflight: [9, 11] }));
    expect(p.paused).toBe(true);
    expect(p.cancel).toEqual([9, 11]);
    expect(p.render).toEqual([10]);
  });

  it("cancels every inflight task on a zoom change", () => {
    expect(cancelAllForZoom([12, 3])).toEqual([3, 12]);
  });

  it("renders nearest page first", () => {
    expect(planWindow(base()).render[0]).toBe(10);
  });
});

describe("release accounting", () => {
  it("reports the byte cost of a mounted canvas", () => {
    const c = { width: 100, height: 50 } as HTMLCanvasElement;
    expect(releasedBytes({ canvas: c })).toBe(20_000);
    expect(releasedBytes({})).toBe(0);
  });

  it("returns the pages it actually released", () => {
    const p = planWindow(base({ mounted: [{ pageIndex: 8, widthPx: 8, heightPx: 8 }, { pageIndex: 99, widthPx: 8, heightPx: 8 }] }));
    expect(p.release).toEqual([99]);
  });
});

describe("pdf adapter seam", () => {
  it("fails closed while pdfjs-dist is absent", async () => {
    await expect(unavailablePdfAdapter.open(new Uint8Array())).rejects.toBeInstanceOf(PdfUnavailableError);
  });

  it("distinguishes a password error from a damaged file", () => {
    expect(classifyPdfOpenError({ name: "PasswordException", code: 1 })).toBe("password");
    expect(classifyPdfOpenError({ name: "InvalidPDFException" })).toBe("damaged");
    expect(classifyPdfOpenError(new Error("boom"))).toBe("unknown");
    expect(new PdfPasswordRequiredError().message).toMatch(/password/i);
  });
});