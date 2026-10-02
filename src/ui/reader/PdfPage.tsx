/**
 * One mounted PDF page: canvas plus its PDF.js text layer plus the marks
 * overlay. The parent decides whether this page is mounted at all — that is the
 * windowing policy's job, and this component does not second-guess it. It only
 * renders, reports its pixel size, and releases everything it owns on unmount.
 *
 * Two coordinate systems, deliberately separate:
 *  - the canvas renders at the windowing policy's DEVICE-pixel scale, so the
 *    bitmap is sharp and the DPR cap applies;
 *  - the text layer is laid out in CSS pixels via `--total-scale-factor`, so
 *    selection rects line up with the CSS-sized page box.
 */

import { useEffect, useRef, useState } from "react";
import type { Mark } from "../../contracts/index.ts";
import { disambiguate } from "../../features/selection/anchor.ts";
import type { PdfjsPageHandle } from "./pdfEngine.ts";

export type PageProps = {
  pageIndex: number;
  /** CSS size of the page box, already zoom-scaled by the windowing policy */
  widthCss: number;
  heightCss: number;
  /** device-pixel scale, already DPR- and edge-capped by the windowing policy */
  scale: number;
  getPage(pageIndex: number): Promise<PdfjsPageHandle>;
  /** marks whose anchor may resolve onto this page */
  marks: readonly Mark[];
  /** this page's original text from the engine, for re-finding a mark */
  pageText: string | undefined;
  /** publish a cancel function so the policy can kill a superseded task */
  registerCancel(pageIndex: number, cancel: (() => void) | undefined): void;
  /** the parent measures this box to work out the visible page and the fraction */
  registerPageBox(pageIndex: number, element: HTMLDivElement | null): void;
  reportPixelSize(pageIndex: number, widthPx: number, heightPx: number): void;
  onTextLayerReady(pageIndex: number, element: HTMLElement): void;
  onRelease(pageIndex: number): void;
};

export function PdfPage(props: PageProps) {
  const { pageIndex, widthCss, heightCss, scale, getPage, marks, pageText, registerCancel, registerPageBox, reportPixelSize, onTextLayerReady, onRelease } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef(true);
  // the marks overlay needs the mounted text layer; this is what makes it rerun
  const [textLayerMounted, setTextLayerMounted] = useState(false);

  useEffect(() => {
    liveRef.current = true;
    let disposed = false;
    let task: { cancel(): void; promise: Promise<void> } | undefined;
    let teardown: (() => Promise<void>) | undefined;
    let handle: PdfjsPageHandle | undefined;

    const canvas = canvasRef.current;
    const textLayer = textLayerRef.current;
    if (canvas === null || textLayer === null) return undefined;
    registerCancel(pageIndex, () => task?.cancel());

    void (async () => {
      const page = await getPage(pageIndex);
      handle = page;
      if (disposed || !liveRef.current) {
        await page.release();
        return;
      }
      task = page.render(canvas, scale);
      reportPixelSize(pageIndex, canvas.width, canvas.height);
      try {
        await task.promise;
      } catch {
        // Cancelled, or torn down mid-render. Section 6 wants supersession to
        // be silent, so this is not surfaced as an error.
        if (!liveRef.current) return;
      }
      if (disposed || !liveRef.current) return;
      try {
        // CSS scale, not device scale: the text layer must align with the
        // CSS-sized page box, whatever the canvas pixel scale is.
        const cssScale = widthCss / Math.max(1, page.size.width);
        teardown = await page.mountTextLayer(textLayer, cssScale);
      } catch {
        // No extractable text on this page: it still renders, it just cannot be
        // selected. Section 6 explains that OCR is unavailable in this release.
        if (liveRef.current) setTextLayerMounted(false);
        return;
      }
      if (disposed || !liveRef.current) {
        await teardown();
        return;
      }
      setTextLayerMounted(true);
      onTextLayerReady(pageIndex, textLayer);
    })();

    return () => {
      disposed = true;
      liveRef.current = false;
      task?.cancel();
      registerCancel(pageIndex, undefined);
      setTextLayerMounted(false);
      const done = teardown;
      teardown = undefined;
      void (async () => {
        // Release through the handle this mount already took. Asking the parent
        // for a page here would register a new one as in-flight on the way out.
        try {
          if (done !== undefined) await done();
          else if (handle !== undefined) await handle.release();
        } catch {
          // releasing twice, or after the document closed, is not an error
        }
        onRelease(pageIndex);
      })();
    };
  }, [pageIndex, scale, widthCss]);

  return (
    <div
      className="reader__page"
      style={{ width: widthCss, height: heightCss }}
      data-page={pageIndex}
      role="group"
      aria-label={`Page ${pageIndex + 1}`}
      ref={(element) => registerPageBox(pageIndex, element)}
    >
      <div className="reader__marks" aria-hidden="true">
        {textLayerMounted && pageText !== undefined ? (
          <MarkHighlights pageIndex={pageIndex} marks={marks} pageText={pageText} textLayer={textLayerRef.current} />
        ) : null}
      </div>
      <canvas ref={canvasRef} aria-label={`Page ${pageIndex + 1}`} role="img" />
      <div ref={textLayerRef} className="textLayer" />
    </div>
  );
}

/**
 * Marks overlay. A mark is re-found in the CURRENT page text (Section 7: no
 * stored anchor contains geometry, so restoring a mark means re-finding its
 * text); it is drawn only when that text is actually found. The rectangles are
 * computed from live client rects for painting only and are never stored.
 */
function MarkHighlights(props: { pageIndex: number; marks: readonly Mark[]; pageText: string; textLayer: HTMLElement | null }) {
  const { pageIndex, marks, pageText, textLayer } = props;
  if (textLayer === null) return null;
  const boxes: { left: number; top: number; width: number; height: number; color: Mark["color"]; id: string }[] = [];
  for (const mark of marks) {
    if (mark.anchor.locator.kind !== "pdf" || mark.anchor.locator.pageIndex !== pageIndex) continue;
    if (mark.anchor.anchorState === "lost") continue;
    const match = disambiguate(pageText, mark.anchor.quote, mark.anchor.prefix, mark.anchor.suffix);
    if (match === undefined) continue;
    const rect = rectOfRange(textLayer, match.originalStart, match.originalEnd);
    if (rect === undefined) continue;
    boxes.push({ ...rect, color: mark.color, id: mark.id });
  }
  return (
    <>
      {boxes.map((b) => (
        <span key={b.id} data-color={b.color} style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />
      ))}
    </>
  );
}

/** Union of the client rects of a character range, in page-local CSS px. */
function rectOfRange(container: HTMLElement, start: number, end: number): { left: number; top: number; width: number; height: number } | undefined {
  const origin = container.getBoundingClientRect();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let first: DOMRect | undefined;
  let last: DOMRect | undefined;
  let node = walker.nextNode();
  while (node !== null) {
    const length = node.textContent?.length ?? 0;
    if (length > 0 && offset < end && offset + length > start) {
      const parent = node.parentElement;
      if (parent !== null) for (const r of Array.from(parent.getClientRects())) {
        first ??= r;
        last = r;
      }
    }
    offset += length;
    node = walker.nextNode();
  }
  if (first === undefined || last === undefined) return undefined;
  const left = Math.min(first.left, last.left) - origin.left;
  const top = Math.min(first.top, last.top) - origin.top;
  const right = Math.max(first.right, last.right) - origin.left;
  const bottom = Math.max(first.bottom, last.bottom) - origin.top;
  if (right <= left || bottom <= top) return undefined;
  return { left, top, width: right - left, height: bottom - top };
}
