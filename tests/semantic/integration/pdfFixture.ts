/**
 * A minimal PDF writer, built BY HAND from bytes.
 *
 * WHY HAND-BUILT: the task allows a new dependency if one is needed to generate
 * a PDF, and this repo has none installed that can write one (pdfjs-dist READS
 * PDFs; it has no writer). Rather than install anything, this constructs the
 * smallest PDF that a real parser accepts — catalog, page tree, one Helvetica
 * Type1 font, and one content stream per page — with a correct cross-reference
 * table. The result is a genuine PDF that the real WASM parses: `classifyPdf`
 * reports `TextBased` and the page count below, so the test is exercising the
 * real parser on a real file, not a stub.
 *
 * The file is deliberately plain: uncompressed content streams, WinAnsi
 * encoding, no embedded font program, no tables or columns. That keeps the
 * fixture's only variable the thing under test, which is page ASSOCIATION.
 * Adversarial geometry, encodings and multi-column layouts belong in the
 * Section 17 corpus, not in a fixture whose job is to prove page order.
 *
 * Where it lives: this module is under tests/semantic/integration/, which is
 * this track's allowlist, and it is shared with the benchmark so both measure
 * the same bytes.
 */

/** One page's worth of text. Each array element is a separate paragraph. */
export type PageSpec = string[];

/**
 * Escape a string for a PDF literal string.
 *
 * Escapes the three structural characters, and additionally escapes anything
 * outside printable ASCII as a three-digit octal escape. That last part is not
 * cosmetic: it makes the generated file PURE ASCII, so one JS char is
 * guaranteed to be one byte, `byteLength` below is exact, and the encoder is a
 * charCode loop. Without it, a non-ASCII character would make the xref offsets
 * wrong and the parser would silently take its repair path — the fixture would
 * still "work" while testing nothing. It also sidesteps `Buffer`, which this
 * repo has no type declarations for.
 */
const escapePdfString = (s: string): string => {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\" || ch === "(" || ch === ")") out += `\\${ch}`;
    else if (c < 32 || c > 126) out += `\\${c.toString(8).padStart(3, "0")}`;
    else out += ch;
  }
  return out;
};

/** Byte length of a string built only from escapePdfString output (pure ASCII). */
const byteLength = (s: string): number => s.length;

/** Latin-1 encode. Valid because escapePdfString guarantees ASCII. */
const toBytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

export type BuildOptions = {
  title?: string;
  /** fixed creation date so the same fixture hashes the same every run */
  creationDate?: string;
};

/**
 * Build a valid, uncompressed PDF whose pages each contain the given
 * paragraphs. Text is laid out with `Td`/`T*` positioning only as a delivery
 * mechanism for the text operators — nothing in this project reads geometry,
 * and the parser's page association must not depend on it.
 */
export function buildPdf(pages: readonly PageSpec[], options: BuildOptions = {}): Uint8Array {
  if (pages.length === 0) throw new Error("buildPdf needs at least one page");

  // Object numbering: 1 catalog, 2 page tree, 3 font, 4 info, then two objects
  // per page (the page dict and its content stream).
  const FONT = 3;
  const INFO = 4;
  const pageObjNum = (i: number): number => 5 + i * 2;
  const objects: string[] = [];

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(" ")}] ` +
    `/Count ${pages.length} >>`;
  // Helvetica with WinAnsi so accented Latin-1 text round-trips as characters
  // rather than as byte soup the parser would have to guess at.
  objects[FONT] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[INFO] =
    `<< /Title (${escapePdfString(options.title ?? "Inspector Fixture")}) ` +
    `/Producer (erc-track-e) /Creator (hand-built fixture) ` +
    `/CreationDate (${options.creationDate ?? "D:20260101000000Z"}) >>`;

  pages.forEach((paragraphs, i) => {
    const pageNum = pageObjNum(i);
    const contentNum = pageNum + 1;

    // One BT/ET text object per page. `TL` sets the leading used by `T*`, and
    // a blank line between paragraphs is a `T*` pair.
    const body: string[] = ["BT", "/F1 11 Tf", "14 TL", "54 738 Td"];
    for (const p of paragraphs) {
      for (const line of p.split("\n")) body.push(`(${escapePdfString(line)}) Tj`, "T*");
      body.push("T*");
    }
    body.push("ET");
    const stream = body.join("\n");

    objects[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Contents ${contentNum} 0 R /Resources << /Font << /F1 ${FONT} 0 R >> >> >>`;
    objects[contentNum] =
      `<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });

  // Serialise with a real xref table. Byte offsets MUST be exact or the
  // parser recovers via its repair path, which would make the test pass for
  // the wrong reason.
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    const obj = objects[n];
    if (obj === undefined) continue;
    offsets[n] = byteLength(out);
    out += `${n} 0 obj\n${obj}\nendobj\n`;
  }

  const size = objects.length;
  const xrefAt = byteLength(out);
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) {
    out += offsets[n] === undefined
      ? "0000000000 65535 f \n"
      : `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${size} /Root 1 0 R /Info ${INFO} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return toBytes(out);
}

/**
 * The three-page fixture the tests assert against.
 *
 * Each page carries a DISTINCTIVE marker sentence. Page order is proved by
 * asserting which page's sentence lands on which zero-based index, so a
 * parser that shifted every boundary by one — or that attributed page 3's text
 * to page 2 — cannot pass.
 */
export const FIXTURE_PAGES: readonly PageSpec[] = [
  [
    "Chapter One: The Reading Habit",
    "The quick brown fox jumps over the lazy dog on the first page of this fixture.",
  ],
  [
    "A reader who skims will miss the qualification in the middle of the sentence.",
    "The word however carries a promise that the following clause must keep or break.",
  ],
  [
    "Vocabulary grows from attention and not from volume.",
    "The third page exists so that page order can be proved rather than assumed by the marker parser.",
  ],
];

/** The sentence that must belong to zero-based page 0. */
export const PAGE_ONE_SENTENCE =
  "The quick brown fox jumps over the lazy dog on the first page of this fixture.";

/** A three-page fixture as real PDF bytes. */
export const buildFixturePdf = (): Uint8Array => buildPdf(FIXTURE_PAGES, { title: "Track E Fixture" });

/**
 * A three-page fixture whose MIDDLE PAGE HAS NO TEXT.
 *
 * This is the case that motivates the per-page fallback, and it cannot be
 * produced by a test double that always emits a marker: the real parser emits
 * NO marker for a page with no text, so the batch response has 2 markers for
 * 3 requested pages. Association must fall back to one call per page and must
 * NOT shift page 3's text onto page 2.
 */
export const buildSparseFixturePdf = (): Uint8Array =>
  buildPdf(
    [
      FIXTURE_PAGES[0]!,
      [], // no content stream text at all
      FIXTURE_PAGES[2]!,
    ],
    { title: "Track E Sparse Fixture" },
  );
