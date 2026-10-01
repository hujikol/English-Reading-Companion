/**
 * Iframe isolation policy for chapter rendering (IDEA.md s8).
 *
 * Selection integration works by the HOST reading `contentDocument` /
 * `getSelection()` from the frame. That needs `allow-same-origin`. It does NOT
 * need `allow-scripts`, and per s8 the two must never be combined — a
 * same-origin frame that can also run scripts escapes the sandbox entirely.
 * Publication scripts stay disabled, so this value is the whole sandbox.
 */

import { sanitizeCss } from "./sanitize.ts";

/** The exact sandbox token list. Asserted on in tests; changing it is a
 * security change. */
export const CHAPTER_SANDBOX = "allow-same-origin";

export function chapterSandboxAttribute(): string {
  return CHAPTER_SANDBOX;
}

/**
 * `srcdoc` CSP. `default-src 'none'` denies scripts, forms, XHR, frames and
 * top navigation in one declaration; `script-src 'none'` and
 * `form-action 'none'` are repeated so a future edit to `default-src` cannot
 * silently re-enable them. Only blobs (locally registered assets) and inline
 * styles (sanitized CSS) are loadable.
 */
export function chapterCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src blob: data:",
    "font-src blob: data:",
    "media-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/** Typography injected into every chapter frame. Book CSS is sanitized and
 * appended by the renderer adapter; this is only the readable baseline. */
export const READER_BASE_CSS =
  "html{-webkit-text-size-adjust:100%}body{margin:0;padding:1em;line-height:1.6;font-family:Georgia,serif;" +
  "overflow-wrap:break-word}img{max-width:100%;height:auto}pre{white-space:pre-wrap}";

export type ChapterFramePolicy = {
  sandbox: string;
  csp: string;
  srcdoc: string;
};

/**
 * Build the complete chapter frame document from ALREADY-SANITIZED body
 * markup. This function does not sanitize: passing unsanitized markup here is
 * a bug at the call site, and the CSP/sandbox pair is the second line of
 * defence that makes such a bug non-exploitable.
 */
export function chapterFramePolicy(sanitizedBody: string, sanitizedCss?: string): ChapterFramePolicy {
  const csp = chapterCsp();
  // CSS never legitimately needs `<`, and inside a <style> element a literal
  // `</style` would terminate it early and hand the rest of the document to
  // the HTML parser. Strip it rather than rely on the parser being lenient.
  const safeCss = sanitizeCss(sanitizedCss ?? "").replace(/</g, "");
  const style = safeCss === "" ? READER_BASE_CSS : `${READER_BASE_CSS}\n${safeCss}`;
  const srcdoc =
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<style>${style}</style>` +
    `</head><body>${sanitizedBody}</body></html>`;
  return { sandbox: chapterSandboxAttribute(), csp, srcdoc };
}
