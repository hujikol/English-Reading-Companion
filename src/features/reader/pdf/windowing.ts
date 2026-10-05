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
  /**
   * Which way the reader is scrolling: 1 forward, -1 backward, 0 or absent
   * when idle. Biases the window so scrolling forward mounts ahead and frees
   * behind, which is what makes continuous scrolling feel continuous.
   */
  scrollDirection?: -1 | 0 | 1;
  /**
   * Override the per-tier radius. Single-page mode uses 0 so exactly one page
   * is mounted; continuous reading uses the tier default.
   */
  radius?: number;
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
  /**
   * Device-pixel scale the canvas bitmap must be rendered at to fill its CSS
   * box: zoom x DPR, after the edge cap. Differs from `scale`, which is the
   * uncapped DPR used for memory accounting — rendering at `scale` would leave
   * a fixed-size bitmap the browser upscales when zoomed.
   */
  renderScale: number;
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
 * `lead` biases the window toward the direction of travel: reading forward
 * mounts more pages ahead than behind, so scrolling never outruns what is
 * mounted and shows blanks. Symmetric when lead is 0.
 *
 * ponytail: radius is uniform per side otherwise. Section 6 says "reduce the
 * window when canvas memory reaches its limit"; a per-side budget split buys
 * little because pages cost the same.
 */
export function windowPages(
  visiblePage: number,
  pageCount: number,
  radius: number,
  extraKeep: readonly number[] = [],
  lead = 0,
): number[] {
  if (pageCount <= 0) return [];
  const v = clampPage(visiblePage, pageCount);
  // `lead` is signed. Positive biases forward, negative backward. Each side is
  // radius + |lead| on the side being travelled toward and radius - |lead| on
  // the side left behind, so the mounted set stays the same size.
  const magnitude = Math.abs(lead);
  const ahead = lead >= 0 ? radius + magnitude : Math.max(0, radius - magnitude);
  const back = lead >= 0 ? Math.max(0, radius - magnitude) : radius + magnitude;
  const out: number[] = [];
  // Each side is walked independently. Adding both sides for every distance —
  // as an earlier version did — grew the window to back+ahead+1 instead of
  // keeping it the same size.
  for (let d = 0; d <= back; d++) {
    const p = v - d;
    if (p >= 0 && !out.includes(p)) out.push(p);
  }
  for (let d = 0; d <= ahead; d++) {
    const p = v + d;
    if (p < pageCount && !out.includes(p)) out.push(p);
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
  // The scale the canvas bitmap must be rendered at to fill its CSS box.
  //
  // pxSize is zoom x DPR; cssSize is zoom x baseWidth. Dividing those cancels
  // the zoom out and always yields DPR — which is exactly what was wrong before.
  // The canvas needs pxSize over the BASE width, so the bitmap grows with the
  // box instead of being upscaled by the browser.
  const renderScale = pxSize.width / Math.max(1, input.viewport.widthCss);
  const perPage = canvasBytes(pxSize.width, pxSize.height);
  const budget = input.budgetBytes ?? CANVAS_BUDGET_BYTES[input.tier];
  const v = clampPage(input.visiblePage, pageCount);

  // An active selection keeps its page mounted; it is never evicted for space.
  const selectionPage = input.selectionPage === undefined ? undefined : clampPage(input.selectionPage, pageCount);

  // The lead is SIGNED: negative must bias the window backward, and taking
  // Math.abs() of it built the same forward window for both directions.
  const lead = input.scrollDirection ?? 0;
  const radius = input.radius ?? WINDOW_RADIUS[input.tier];
  let keep = windowPages(
    v,
    pageCount,
    radius,
    selectionPage === undefined ? [] : [selectionPage],
    lead * radius,
  );

  // Memory shrink path: drop a page until the budget is met. The visible page
  // and the selection's page are pinned and never dropped. Pages behind the
  // direction of travel go first, so a tight budget trims the tail the reader
  // has already passed rather than the one they are scrolling into.
  const pinned = new Set<number>([v, ...(selectionPage === undefined ? [] : [selectionPage])]);
  // Bias only when the reader is actually moving. Idle must keep the original
  // "drop the farthest" rule with a neutral tie-break, or a resting reader's
  // window would drift to one side on its own.
  const behindFirst = lead === 0
    ? (): number => 0
    : lead > 0
      ? (a: number, b: number): number => (b - v) - (a - v)
      : (a: number, b: number): number => (a - v) - (b - v);
  const farthest = (): number | undefined =>
    keep
      .filter((p) => !pinned.has(p))
      .sort((a, b) => Math.abs(a - v) - Math.abs(b - v) || behindFirst(a, b))
      .pop();
  while (keep.length * perPage > budget) {
    const drop = farthest();
    if (drop === undefined) break; // budget below one page: keep the pins only
    keep = keep.filter((p) => p !== drop);
  }

  const keepSet = new Set(keep);
  const nearest = (a: number, b: number): number => Math.abs(a - v) - Math.abs(b - v);
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
    renderScale,
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
