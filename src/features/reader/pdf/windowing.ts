/**
 * Render windowing policy. Pure: no PDF.js, no DOM, no canvas. Given the
 * visible page, a device tier, a canvas memory budget and per-page pixel cost it
 * returns what to mount, what to release and what to cancel.
 *
 * Section 6: visible page plus two pages each side on desktop, one on phones;
 * reduce the window when canvas memory reaches its limit; cancel superseded
 * render tasks; release distant canvases, text layers and object URLs; keep an
 * active selection's page mounted until selection ends; pause speculative work
 * when the tab is hidden; cap effective device-pixel scaling so zoom cannot
 * allocate an unbounded canvas.
 */

import type { DeviceTier } from "../../library/validate.ts";

/** Section 16 "Active canvas allocation". Sum of active pixel buffers. */
export const CANVAS_BUDGET_BYTES: Record<DeviceTier, number> = {
  desktop: 64 * 1024 * 1024,
  phone: 24 * 1024 * 1024,
};

export const WINDOW_RADIUS: Record<DeviceTier, number> = { desktop: 2, phone: 1 };

/** Section 6: cap effective device-pixel scaling and individual canvas dimensions. */
export const MAX_DEVICE_PIXEL_RATIO = 2;
export const MAX_CANVAS_EDGE = 8192;

export type Viewport = { widthCss: number; heightCss: number };

/** A mounted page and what it currently costs. */
export type MountedPage = { pageIndex: number; widthPx: number; heightPx: number };

/** Everything the policy needs to decide. */
export type WindowInput = {
  /** the page currently at the top of the viewport */
  visiblePage: number;
  pageCount: number;
  tier: DeviceTier;
  /** currently mounted pages with their last allocated pixel size */
  mounted: readonly MountedPage[];
  /** base CSS size of one page, before zoom */
  viewport: Viewport;
  zoom: number;
  devicePixelRatio: number;
  /** override for tests; defaults to CANVAS_BUDGET_BYTES[tier] */
  budgetBytes?: number;
  /** pages an in-progress render task is working on */
  inflight?: readonly number[];
  /** page holding the live selection; stays mounted until selection ends */
  selectionPage?: number;
  tabVisible: boolean;
};

export type WindowPlan = {
  /** pages to keep mounted, ascending, always including the visible page */
  keep: number[];
  /** pages to render or keep rendering now, nearest first */
  render: number[];
  /** pages to release: canvas, text layer and any object URL */
  release: number[];
  /** inflight page indexes whose task is superseded and must be cancelled */
  cancel: number[];
  /** pages outside the render budget but still mounted; speculation paused */
  paused: boolean;
  /** per-page CSS size after zoom */
  cssSize: Viewport;
  /** per-page device pixel size after the DPR and edge caps */
  pxSize: { width: number; height: number };
  /** effective scale actually applied; never above MAX_DEVICE_PIXEL_RATIO */
  scale: number;
  /** kept pages + pxSize at the planned scale */
  budgetBytes: number;
};

const MAX_SCALE = MAX_DEVICE_PIXEL_RATIO;

/**
 * Effective device-pixel scale for one page. Zoom multiplies, the display DPR
 * multiplies, then the result is capped — so 800% zoom on a 3x phone still
 * allocates the capped canvas instead of an unbounded one.
 */
export function effectiveScale(zoom: number, devicePixelRatio: number): number {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(z * dpr, MAX_SCALE);
}

/** DPR-only scale for a CSS size that already has zoom applied. Same cap. */
export const pixelScale = (devicePixelRatio: number): number => effectiveScale(1, devicePixelRatio);

const capEdge = (n: number): number => Math.max(1, Math.min(Math.round(n), MAX_CANVAS_EDGE));

export const canvasBytes = (w: number, h: number): number => w * h * 4;

function clampPage(p: number, pageCount: number): number {
  const max = Math.max(0, pageCount - 1);
  const i = Math.floor(Number.isFinite(p) ? p : 0);
  return i < 0 ? 0 : i > max ? max : i;
}

/**
 * Pages in the window, nearest to the visible page first.
 *
 * ponytail: the radius shrinks uniformly rather than per-side. Section 6 says
 * "reduce the window when canvas memory reaches its limit"; a per-side budget
 * split buys little because pages cost the same. Revisit if measurement shows
 * backward-biased reading wants a longer trailing window.
 */
export function windowPages(visiblePage: number, pageCount: number, radius: number, extraKeep: readonly number[] = []): number[] {
  if (pageCount <= 0) return [];
  const v = clampPage(visiblePage, pageCount);
  const out: number[] = [];
  for (let d = 0; d <= radius; d++) {
    for (const p of [v - d, v + d]) {
      if (p >= 0 && p < pageCount && !out.includes(p)) out.push(p);
    }
  }
  for (const p of extraKeep) {
    const i = clampPage(p, pageCount);
    if (!out.includes(i)) out.push(i);
  }
  return out.sort((a, b) => a - b);
}

export function planWindow(input: WindowInput): WindowPlan {
  const pageCount = Math.max(0, Math.floor(input.pageCount));
  const zoom = Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1;
  const cssSize = { widthCss: Math.max(1, input.viewport.widthCss * zoom), heightCss: Math.max(1, input.viewport.heightCss * zoom) };
  // pixel scale is DPR only — zoom already lives in cssSize, so multiplying by it
  // again here would allocate a canvas quadratic in zoom
  const scale = pixelScale(input.devicePixelRatio);
  const pxSize = { width: capEdge(cssSize.widthCss * scale), height: capEdge(cssSize.heightCss * scale) };
  const perPage = canvasBytes(pxSize.width, pxSize.height);
  const budget = input.budgetBytes ?? CANVAS_BUDGET_BYTES[input.tier];
  const v = clampPage(input.visiblePage, pageCount);

  // An active selection keeps its page mounted; it is never evicted for space.
  const selectionPage = input.selectionPage === undefined ? undefined : clampPage(input.selectionPage, pageCount);

  let keep = windowPages(v, pageCount, WINDOW_RADIUS[input.tier], selectionPage === undefined ? [] : [selectionPage]);

  // Memory shrink path: drop the farthest page until the budget is met. The
  // visible page and the selection's page are pinned and never dropped.
  const pinned = new Set<number>([v, ...(selectionPage === undefined ? [] : [selectionPage])]);
  const dist = (a: number, b: number): number => Math.abs(a - v) - Math.abs(b - v);
  while (keep.length * perPage > budget) {
    // last after ascending sort == farthest from the visible page
    const farthest = keep.filter((p) => !pinned.has(p)).sort(dist).pop();
    if (farthest === undefined) break; // budget below one page: keep the pins only
    keep = keep.filter((p) => p !== farthest);
  }

  const keepSet = new Set(keep);
  const nearest = (a: number, b: number): number => dist(a, b);
  const render = keep.slice().sort(nearest);

  const mounted = new Set(input.mounted.map((p) => p.pageIndex));
  const release = [...mounted].filter((p) => !keepSet.has(p)).sort((a, b) => a - b);

  const inflight = input.inflight ?? [];
  const visible = input.tabVisible;
  // Superseded: no longer in the keep set, or speculation is paused by a hidden tab.
  const cancel = inflight.filter((p) => !keepSet.has(p) || !visible).sort((a, b) => a - b);

  return {
    keep,
    render: visible ? render : render.slice(0, 1),
    release,
    cancel,
    paused: !visible,
    cssSize,
    pxSize,
    scale,
    budgetBytes: keep.length * perPage,
  };
}

/** Zoom change: every inflight task is stale, because the canvas size changed. */
export const cancelAllForZoom = (inflight: readonly number[]): number[] => [...inflight].sort((a, b) => a - b);

/** Everything a released page owns, per Section 6, in one call. */
export type PageResources = { canvas?: HTMLCanvasElement; textLayer?: HTMLElement; objectUrls?: readonly string[] };

export type Releaser = (pageIndex: number, res: PageResources) => void;

/** Byte size at which a page is considered released; used by the memory readout. */
export const releasedBytes = (res: PageResources): number => (res.canvas ? canvasBytes(res.canvas.width, res.canvas.height) : 0);

/**
 * Release a plan's pages. Each canvas is shrunk to 0x0 first, because a detached
 * canvas may still hold its backing store until GC; then the text layer is
 * removed and every object URL revoked.
 */
export function releasePages(plan: WindowPlan, mounted: ReadonlyMap<number, PageResources>, release: Releaser): number[] {
  const done: number[] = [];
  for (const p of plan.release) {
    const res = mounted.get(p);
    if (res === undefined) continue;
    if (res.canvas) {
      res.canvas.width = 0;
      res.canvas.height = 0;
    }
    res.textLayer?.remove();
    for (const url of res.objectUrls ?? []) URL.revokeObjectURL(url);
    release(p, res);
    done.push(p);
  }
  return done;
}
