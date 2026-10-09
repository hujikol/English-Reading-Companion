/**
 * The real PDF.js engine, behind the existing adapter seam.
 *
 * `features/reader/pdf/adapter.ts` keeps its pure classification helpers and its
 * `PdfAdapter` / `PdfDocument` / `PdfPageHandle` contract — the windowing policy
 * and the selection code still never import pdfjs-dist directly. This file is
 * the one implementation of that contract.
 *
 * Section 6: the worker is SELF-HOSTED and bundled by Vite (`?worker` emits it as
 * its own chunk), so no CDN, no runtime URL to keep in sync with the package
 * version, and nothing about the document leaves the origin. The engine is
 * imported lazily by the reader so `pdfjs-dist` never lands in the initial
 * bundle.
 *
 * Ponytail: no plugin registration, no annotation layer, no XFA. Section 6 wants
 * the library's own renderer, not a custom glyph renderer.
 */

import type { PdfAdapter, PdfCapabilities, PdfPageHandle, PdfPassword, RenderTask } from "../../features/reader/pdf/adapter.ts";
import { PdfPasswordRequiredError, classifyPdfOpenError } from "../../features/reader/pdf/adapter.ts";
import { pageTextOf, readingTextOf } from "./pageText.ts";

/**
 * The slice of the pdfjs API this file uses. Structural rather than
 * `typeof import("pdfjs-dist")` so the Node legacy build satisfies the same
 * type, which is what makes the engine testable against real pdfjs without a
 * canvas.
 */
export type PdfjsModule = Pick<typeof import("pdfjs-dist"), "getDocument" | "GlobalWorkerOptions" | "TextLayer">;

let engine: PdfjsModule | undefined;
let workerReady = false;

/**
 * Load pdfjs-dist once and point it at a Vite-bundled worker.
 *
 * `?worker` is Vite-native: the worker file is emitted into the build output as
 * its own chunk and constructed from a real `Worker`. Nothing is copied into
 * public/ by hand, so the worker can never drift from the installed version.
 */
async function loadEngine(): Promise<PdfjsModule> {
  if (engine !== undefined) return engine;
  const pdfjsLib: PdfjsModule = await import("pdfjs-dist");
  if (!workerReady) {
    const { default: PdfWorker } = await import("pdfjs-dist/build/pdf.worker.mjs?worker");
    // pdfjs types this as `Worker | null`; Vite's `*?worker` module declaration
    // returns a Worker. One cast at this single boundary.
    pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker() as unknown as Worker;
    workerReady = true;
  }
  engine = pdfjsLib;
  return pdfjsLib;
}

/**
 * `cmaps` and `standard_fonts` are served from public/pdfjs by the offline
 * track; a PDF that needs them before those files land still renders, just with
 * pdfjs's fallback glyphs. Absent rather than wrong: a 404 here must not be able
 * to break a plain Latin PDF.
 */
const assetUrl = (dir: string, file: string): string => `/pdfjs/${dir}/${file}`;

type LoadedPage = import("pdfjs-dist").PDFPageProxy;

class PdfjsPage implements PdfjsPageHandle {
  constructor(
    readonly pageIndex: number,
    private readonly page: LoadedPage,
    private readonly baseViewport: import("pdfjs-dist").PageViewport,
  ) {}

  get size(): { width: number; height: number } {
    return { width: this.baseViewport.width, height: this.baseViewport.height };
  }

  /**
   * `scale` here is the DEVICE-PIXEL scale. The CSS size is the caller's job,
   * because the windowing policy already decided both numbers (`cssSize` and
   * `pxSize`) and it is the only thing allowed to cap DPR and canvas edges.
   */
  render(canvas: HTMLCanvasElement, scale: number): RenderTask {
    const viewport = this.page.getViewport({ scale });
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const task = this.page.render({ canvas, viewport });
    return { cancel: () => task.cancel(), promise: task.promise };
  }

  /** Original page text, in PDF.js reading order. Used for selection context. */
  async text(): Promise<string> {
    const content = await this.page.getTextContent();
    // NOT items.join(" "): PDF.js splits single words across items, so a naive
    // join injects spaces inside them ("oppor tunities"). pageTextOf decides
    // spacing from the item geometry.
    return pageTextOf(content.items);
  }

  async readingText(isWord: (word: string) => Promise<boolean>): Promise<string> {
    return readingTextOf((await this.page.getTextContent()).items, isWord);
  }

  /**
   * Build the selectable text layer for this page. Owned by the caller.
   *
   * `scale` is CSS pixels per PDF point, NOT the device-pixel scale: PDF.js
   * positions every text span with `calc(var(--total-scale-factor) * Npx)` in
   * unscaled page units, and PDF.js itself never sets that variable — in the
   * official viewer the host sets it. Without it every span resolves to an
   * invalid length and selection lands in the wrong place, so it is set here.
   */
  async mountTextLayer(container: HTMLElement, scale: number): Promise<() => Promise<void>> {
    const pdfjsLib = await loadEngine();
    const viewport = this.page.getViewport({ scale });
    container.style.setProperty("--total-scale-factor", String(scale));
    const layer = new pdfjsLib.TextLayer({
      textContentSource: this.page.streamTextContent({ includeMarkedContent: false }),
      container,
      viewport,
    });
    await layer.render();
    return async () => {
      // TextLayer has no destroy in this version; emptying the container drops
      // every span it created, which is what releasePages measures.
      container.replaceChildren();
      container.style.removeProperty("--total-scale-factor");
      await this.page.cleanup();
    };
  }

  async release(): Promise<void> {
    await this.page.cleanup();
  }
}

/**
 * Wrap an already-loaded pdfjs document. Exported so a test can drive REAL
 * pdfjs (Node legacy build, real PDF bytes) through the exact same page and
 * text handling the browser uses.
 */
export const wrapDocument = (doc: import("pdfjs-dist").PDFDocumentProxy, loadingTask: import("pdfjs-dist").PDFDocumentLoadingTask): PdfjsDocumentHandle => new PdfjsDocument(doc, loadingTask);

class PdfjsDocument implements PdfjsDocumentHandle {
  constructor(
    private readonly doc: import("pdfjs-dist").PDFDocumentProxy,
    private readonly loadingTask: import("pdfjs-dist").PDFDocumentLoadingTask,
  ) {}

  get capabilities(): PdfCapabilities {
    return {
      // Opening succeeded, so either there was no password or one was supplied.
      needsPassword: false,
      ocr: false,
      // Section 6: the browser semantic path emits no positioned text.
      positionedText: false,
      pageCount: this.doc.numPages,
    };
  }

  async page(pageIndex: number): Promise<PdfjsPageHandle> {
    // PDF.js pages are 1-based; the Locator contract is 0-based.
    const page = await this.doc.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    return new PdfjsPage(pageIndex, page, base);
  }

  async destroy(): Promise<void> {
    await this.loadingTask.destroy();
  }
}

/** Real adapter. Throws `PdfPasswordRequiredError` for an encrypted file. */
export const pdfjsAdapter: PdfjsAdapter = {
  async open(bytes: Uint8Array, password?: PdfPassword): Promise<PdfjsDocumentHandle> {
    const pdfjsLib = await loadEngine();
    let loadingTask: import("pdfjs-dist").PDFDocumentLoadingTask;
    try {
      loadingTask = pdfjsLib.getDocument({
        // A copy, because PDF.js may transfer the buffer to its worker and a
        // detached buffer would take the caller's hashing input with it
        // (Section 6, memory ownership).
        data: bytes.slice(),
        cMapUrl: assetUrl("cmaps", ""),
        cMapPacked: true,
        standardFontDataUrl: assetUrl("standard_fonts", ""),
        // No scripting, no external resources: Section 18 forbids remote
        // document resources, so nothing here may reach the network.
        isEvalSupported: false,
        disableAutoFetch: false,
        ...(password === undefined ? {} : { password }),
      });
      const doc = await loadingTask.promise;
      return new PdfjsDocument(doc, loadingTask);
    } catch (e) {
      const kind = classifyPdfOpenError(e);
      if (kind === "password") throw new PdfPasswordRequiredError();
      throw e instanceof Error ? e : new Error("The PDF could not be opened.");
    }
  },
};

/**
 * A page also exposes the text-layer builder, so the reader can mount a
 * selectable layer over a canvas it already rendered.
 */
export type PdfjsPageHandle = PdfPageHandle & {
  readingText?(isWord: (word: string) => Promise<boolean>): Promise<string>;
  mountTextLayer(container: HTMLElement, scale: number): Promise<() => Promise<void>>;
};

export type PdfjsDocumentHandle = {
  capabilities: PdfCapabilities;
  page(pageIndex: number): Promise<PdfjsPageHandle>;
  destroy(): Promise<void>;
};

/** Still the `PdfAdapter` seam: this implementation just returns richer handles. */
export type PdfjsAdapter = Omit<PdfAdapter, "open"> & {
  open(bytes: Uint8Array, password?: PdfPassword): Promise<PdfjsDocumentHandle>;
};
