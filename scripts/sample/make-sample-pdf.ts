/**
 * Emit a small, real multi-page PDF for manual verification.
 *
 * Mirrors the EPUB generator's purpose: the test suite drives real PDF bytes in
 * memory, but nothing exists on disk to open in a browser. Written by hand
 * because no PDF *writer* is installed — pdfjs-dist only reads.
 *
 *   npm run sample:pdf         # -> public/sample/sample-book.pdf
 *
 * Three pages, with a text layer so selection works. The prose uses words the
 * shipped dictionary contains (ferry, water, time, narrow, surface) so the
 * lookup card can be exercised against a real gloss.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", "public", "sample", "sample-book.pdf");

const PAGES = [
  ["The Crossing", ["The ferry left the harbour at dawn.", "The water was quiet for a long time."]],
  ["Rain", ["Rain arrived before the lighthouse.", "The wind began to drift across the deck."]],
  ["Flat Water", ["By noon the water had gone flat.", "She remembered the crossing for years."]],
] as const;

const esc = (s: string) => s.replace(/([\\()])/g, "\\$1");

/**
 * One content stream, emitting ONE Tj PER WORD.
 *
 * Real books do this: PDF.js reports one item per text-showing operator, so a
 * word routinely arrives split across several items. A fixture that emits whole
 * lines hides the class of bug that produces "oppor tunities".
 */
const contentFor = (lines: readonly string[]) => {
  const ops: string[] = ["BT", "/F1 18 Tf", "72 760 Td"];
  let first = true;
  for (const line of lines) {
    for (const word of line.split(" ")) {
      if (word === "") continue;
      ops.push(`${first ? "" : "0 -28 Td"}(${esc(word)}) Tj`);
      first = false;
    }
  }
  ops.push("ET");
  return ops.join("\n");
};

/**
 * Assemble the PDF. Object numbering is fixed and explicit: a generator that
 * computed offsets would need a second pass, and this is a fixed three pages.
 */
function build(): Uint8Array {
  const objects: string[] = [];
  const pageCount = PAGES.length;
  // 1 catalog, 2 pages, 3 font, then per page: page object + content stream.
  const firstPageObj = 4;

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${PAGES.map(
    (_, i) => `${firstPageObj + i * 2} 0 R`,
  ).join(" ")}] >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  PAGES.forEach(([title, lines], i) => {
    const pageObj = firstPageObj + i * 2;
    const contentObj = pageObj + 1;
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`;
    objects[contentObj] = `<< /Length ${contentFor([title, ...lines]).length} >>\nstream\n${contentFor([title, ...lines])}\nendstream`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    const body = objects[i];
    if (body === undefined) continue;
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${body}\nendobj\n`;
  }

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    pdf += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

mkdirSync(dirname(OUT), { recursive: true });
const bytes = build();
writeFileSync(OUT, bytes);
process.stdout.write(`wrote ${OUT} (${bytes.length} bytes, ${PAGES.length} pages)\n`);
