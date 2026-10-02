/**
 * The engine against REAL pdfjs and REAL PDF bytes.
 *
 * This is not a mock: `pdfjs-dist/legacy` is the same library the browser build
 * loads, and the fixture is a byte-accurate PDF written by `samplePdf.ts`. What
 * it proves here is everything the engine does that does not need a rasterizer
 * — opening, page count, 0-based page identity, viewport geometry at a given
 * scale, page text extraction, cleanup and password classification.
 *
 * What it cannot prove, stated plainly: the canvas rasterization and the
 * `?worker` bundling. Those need a browser, and there is no DOM or canvas
 * polyfill in this test environment (and installing one is out of scope).
 */

import { describe, expect, it } from "vitest";
import { classifyPdfOpenError, PdfPasswordRequiredError } from "../../../src/features/reader/pdf/adapter.ts";
import { wrapDocument } from "../../../src/ui/reader/pdfEngine.ts";
import { makeSamplePdf, PAGES } from "./samplePdf.ts";

/** pdfjs in Node: the legacy build is the one designed for a non-DOM runtime. */
const pdfjs = async () => {
  // typed as the browser build; the legacy build exposes the same named exports
  return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as typeof import("pdfjs-dist");
};

const openFixture = async () => {
  const lib = await pdfjs();
  const bytes = makeSamplePdf();
  const task = lib.getDocument({ data: bytes, disableFontFace: true, useSystemFonts: false });
  const doc = await task.promise;
  return { doc, task, lib, bytes };
};

describe("real pdfjs opens the fixture", () => {
  it("reports the real page count", async () => {
    const { doc, task } = await openFixture();
    const handle = wrapDocument(doc, task);
    expect(handle.capabilities.pageCount).toBe(PAGES.length);
    expect(handle.capabilities.pageCount).toBe(6);
    await handle.destroy();
  });

  it("declares render-only capabilities honestly", async () => {
    const { doc, task } = await openFixture();
    const handle = wrapDocument(doc, task);
    expect(handle.capabilities).toMatchObject({ needsPassword: false, ocr: false, positionedText: false });
    await handle.destroy();
  });
});

describe("page identity is the 0-based Locator identity", () => {
  it("maps pageIndex 0 to the first page, not to an error", async () => {
    const { doc, task } = await openFixture();
    const handle = wrapDocument(doc, task);
    const first = await handle.page(0);
    expect(first.pageIndex).toBe(0);
    expect(first.text()).toBeInstanceOf(Promise);
    await handle.destroy();
  });

  it("returns each page's own text, so a mark can name its page", async () => {
    const { doc, task } = await openFixture();
    const handle = wrapDocument(doc, task);
    const first = await handle.page(0);
    const text = await first.text();
    expect(text).toContain("English Reading Companion");
    expect(text).toContain("real text layer");
    // a page that is not the first does not leak the first page's words
    const fifth = await handle.page(4);
    expect(await fifth.text()).not.toContain("English Reading Companion");
    expect(await fifth.text()).toContain("Zoom changes the page box");
    await handle.destroy();
  });

  it("releases a page without throwing", async () => {
    const { doc, task } = await openFixture();
    const handle = wrapDocument(doc, task);
    const page = await handle.page(2);
    await expect(page.release()).resolves.toBeUndefined();
    await handle.destroy();
  });
});

describe("viewport geometry feeds the windowing policy", () => {
  it("reports the page's unscaled size, which is the policy's zoom base", async () => {
    const { doc, task } = await openFixture();
    const handle = wrapDocument(doc, task);
    const page = await handle.page(0);
    // US Letter at scale 1
    expect(page.size.width).toBeCloseTo(612, 0);
    expect(page.size.height).toBeCloseTo(792, 0);
    await handle.destroy();
  });
});

describe("failure classification uses the adapter's own rules", () => {
  it("maps a password-protected file to a password error", () => {
    // The rule under test belongs to the seam; assert the seam agrees with what
    // the engine would throw, rather than inventing a second mapping here.
    expect(classifyPdfOpenError({ name: "PasswordException" })).toBe("password");
    expect(new PdfPasswordRequiredError().message).toMatch(/password/i);
  });

  it("maps a damaged file to a damaged file", () => {
    expect(classifyPdfOpenError({ name: "InvalidPDFException" })).toBe("damaged");
  });

  it("does not swallow an unrelated failure", () => {
    expect(classifyPdfOpenError(new Error("boom"))).toBe("unknown");
  });
});

describe("the fixture is a real PDF, not a stub", () => {
  it("has the byte signature, an xref table and a trailer", () => {
    const bytes = makeSamplePdf();
    const head = String.fromCharCode(...bytes.slice(0, 8));
    const all = String.fromCharCode(...bytes);
    expect(head).toBe("%PDF-1.7");
    expect(all).toContain("/Type /Catalog");
    expect(all).toContain("xref");
    expect(all).toContain("%%EOF");
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
