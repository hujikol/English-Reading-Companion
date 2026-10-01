/**
 * The PDF.js seam. Everything above this file is pure and tested without
 * pdfjs-dist; the engine itself lives behind this interface so the windowing
 * policy, import validation and identity code never import it.
 *
 * `pdfjs-dist` is NOT yet a dependency. Track A must add it before any real
 * renderer is wired. Until then the only implementation available is
 * `unavailablePdfAdapter`, which fails closed with an actionable message.
 *
 * Dependency spec requested from Track A (see report):
 *   pdfjs-dist@5.4.149
 *   - required by:   the `PdfDocument` implementation below, once written
 *   - why this pin:  `build/pdf.mjs` exposes the ES module entry, `getDocument`
 *                   accepts `{ data }`, the worker is loaded from a self-hosted
 *                   `build/pdf.worker.mjs` (no CDN), and `renderTask.cancel()` /
 *                   `page.cleanup()` are the only cancellation and release
 *                   primitives the windowing policy needs.
 *   - also required: copying `build/pdf.worker.mjs` and the `cmaps/` +
 *                   `standard_fonts/` directories into `public/pdfjs/`, because
 *                   Section 18 forbids remote document resources and Section 19
 *                   requires self-hosted assets before "Ready offline".
 *   - not used by Track B at scaffold time: text layer CSS is imported by the
 *     adapter, not here.
 */

export type PdfPageSize = { width: number; height: number };

export type PdfPageHandle = {
  pageIndex: number;
  size: PdfPageSize;
  render(canvas: HTMLCanvasElement, scale: number): RenderTask;
  /** original text layer of the page, used for selection and anchor capture */
  text(): Promise<string>;
  release(): Promise<void>;
};

export type RenderTask = { cancel(): Promise<void> | void; promise: Promise<void> };

export type PdfCapabilities = {
  /** encrypted file needs a password before pages are available */
  needsPassword: boolean;
  /** OCR is out of scope for v0.1 */
  ocr: false;
  /** the browser semantic path emits no positioned text, by decision */
  positionedText: false;
  pageCount: number;
};

export type PdfDocument = {
  capabilities: PdfCapabilities;
  page(pageIndex: number): Promise<PdfPageHandle>;
  /** release the document, its worker and any object URLs it created */
  destroy(): Promise<void>;
};

export type PdfPassword = string | undefined;

/**
 * Open a validated local file. Throws `PdfPasswordRequiredError` when the file
 * is encrypted and no password was supplied — never a generic failure, because
 * Section 6 requires render-only operation to remain available.
 */
export type PdfAdapter = {
  open(bytes: Uint8Array, password?: PdfPassword): Promise<PdfDocument>;
};

export class PdfPasswordRequiredError extends Error {
  constructor() {
    super("This PDF is password protected.");
    this.name = "PdfPasswordRequiredError";
  }
}

export class PdfUnavailableError extends Error {
  constructor() {
    super("PDF rendering is not installed yet (pdfjs-dist is missing).");
    this.name = "PdfUnavailableError";
  }
}

/** Fails closed. Used until Track A adds the dependency and an implementation. */
export const unavailablePdfAdapter: PdfAdapter = {
  async open() {
    throw new PdfUnavailableError();
  },
};

/** normalize a PDF.js PasswordException / response-shaped error to one enum */
export const classifyPdfOpenError = (e: unknown): "password" | "damaged" | "unsupported" | "unknown" => {
  const name = typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
  if (name === "PasswordException" || code === "PasswordException" || code === "1") return "password";
  if (name === "InvalidPDFException" || code === "InvalidPDFException") return "damaged";
  if (name === "MissingPDFException" || name === "UnexpectedResponseException") return "unsupported";
  return "unknown";
};

export const passwordErrorMessage = "Enter this PDF's password to open it. It is kept in memory for this session only.";
export const damagedErrorMessage = "This PDF is damaged and cannot be opened. Re-download or re-export it.";
