import { describe, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { openRawDocument, pageFromInput, plainText, sameUnit } from "../../../src/ui/reader/rawDocument.ts";
import { pdfjsAdapter, wrapDocument } from "../../../src/ui/reader/pdfEngine.ts";
import { makeSamplePdf } from "./samplePdf.ts";
import { CONTAINER_XML, OPF_XML } from "../../formats/zip-fixtures.ts";

it("validates page input without destroying editable drafts or truncating decimals", () => {
  expect(pageFromInput("12", 20)).toBe(11);
  expect(pageFromInput("0", 20)).toBe(0);
  expect(pageFromInput("999", 20)).toBe(19);
  for (const raw of ["", "1.2", "1x", "-1", "99999999999999999999"]) expect(pageFromInput(raw, 20)).toBeUndefined();
});
it("extracts Markdown as readable text and restores its section", async () => {
  const doc = await openRawDocument(new File(["# Hello\n\nA **good** book.\n\nNext paragraph."], "book.md"));
  expect(doc.count).toBe(3);
  const unit = await doc.read(1);
  expect(unit.text).toBe("A good book.");
  expect(doc.indexOf(unit.locator)).toBe(1);
  expect(sameUnit(unit.locator, (await doc.read(2)).locator)).toBe(false);
  await doc.close();
});
it("preserves EPUB paragraph boundaries, removes scripts, and restores chapters", async () => {
  const bytes = zipSync({ mimetype: strToU8("application/epub+zip"), "META-INF/container.xml": strToU8(CONTAINER_XML),
    "OEBPS/content.opf": strToU8(OPF_XML), "OEBPS/ch1.xhtml": strToU8("<html><body><p>One</p><p>Two &amp; three.</p><script>alert(1)</script></body></html>"),
    "OEBPS/ch2.xhtml": strToU8("<html><body><p>Second chapter</p></body></html>") }, { level: 0 });
  const doc = await openRawDocument(new File([Uint8Array.from(bytes).buffer], "book.epub"));
  expect((await doc.read(0)).text).toBe("One\nTwo & three.");
  expect(doc.indexOf((await doc.read(1)).locator)).toBe(1);
  await doc.close();
});
it("extracts each real PDF page without calling canvas or text-layer renderers", async () => {
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = makeSamplePdf();
  const task = lib.getDocument({ data: bytes.slice(), disableFontFace: true });
  const handle = wrapDocument(await task.promise, task);
  const open = vi.spyOn(pdfjsAdapter, "open").mockResolvedValue(handle);
  try {
    const doc = await openRawDocument(new File([Uint8Array.from(bytes).buffer], "book.pdf", { type: "application/pdf" }));
    expect(doc.count).toBe(6);
    expect((await doc.read(3)).text).toContain("Page four");
    expect(doc.indexOf({ kind: "pdf", pageIndex: 3, pageFraction: 0 })).toBe(3);
    await doc.close();
  } finally { open.mockRestore(); }
});
it("TXT content stays literal, including untrusted markup", async () => {
  const doc = await openRawDocument(new File(["<script>unsafe()</script>\n\nSecond section"], "book.txt"));
  expect((await doc.read(0)).text).toBe("<script>unsafe()</script>");
  expect(doc.indexOf((await doc.read(1)).locator)).toBe(1);
  await doc.close();
});
it("preserves paragraph boundaries in sanitized markup", () => {
  expect(plainText("<p>first</p><p>second<br/>line</p>")).toBe("first\nsecond\nline");
});
