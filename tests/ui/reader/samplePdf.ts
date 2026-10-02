/**
 * A real, minimal PDF generator for manual testing. Six pages of Helvetica text
 * with a genuine text layer, built byte by byte so the reader has something
 * honest to render: real page count, real selectable text, real page geometry.
 *
 * ponytail: no dependency, no font embedding, no compression. Enough to prove
 * rendering, paging, selection and bookmarks; not a PDF library.
 */

const latin1 = (text: string): number[] => {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xff);
  return bytes;
};

const escape = (text: string): string => text.replace(/([()\\])/g, "\\$1");

/** Content stream: one Tj per line, 14pt leading from a 72pt margin. */
const contentFor = (lines: readonly string[]): string =>
  ["BT", "/F1 12 Tf", "16 TL", "72 720 Td", ...lines.flatMap((line) => [`(${escape(line)}) Tj`, "T*"]), "ET"].join("\n");

export type SamplePdfOptions = { pages: readonly (readonly string[])[] };

export const PAGES: string[][] = [
  [
    "English Reading Companion",
    "",
    "Reader fixture page one. This text is a real text layer,",
    "so selecting it produces a real DOM selection.",
    "",
    "Try selecting the sentence above, then mark it yellow.",
  ],
  [
    "Page two",
    "",
    "Windowing policy: the visible page plus two pages",
    "on each side stays mounted on desktop.",
    "",
    "Scrolling to this page should show three to five",
    "page boxes in the scroll container.",
  ],
  [
    "Page three",
    "",
    "Bookmarks point at positions. Marks point at spans",
    "of text the learner chose.",
    "",
    "They are different things and use different",
    "affordances, so one gesture never creates both.",
  ],
  [
    "Page four",
    "",
    "Progress is saved after the position settles, not",
    "before, and never reports Saved until the write",
    "has actually resolved.",
    "",
    "Reloading the reader restores this page.",
  ],
  [
    "Page five",
    "",
    "Zoom changes the page box without changing the",
    "document layout, and the canvas allocation is",
    "capped so zoom cannot ask for an unbounded one.",
  ],
  [
    "Page six",
    "",
    "Last page. If you can read this after paging",
    "through from page one, rendering, navigation,",
    "windowing and release all worked.",
  ],
];

/** Build the PDF bytes. Object numbers are fixed so the xref table is exact. */
export function makeSamplePdf(options: SamplePdfOptions = { pages: PAGES }): Uint8Array {
  const { pages } = options;
  // 1 catalog, 2 page tree, 3 font, then (content, page) per page from 4
  const contentNumbers: number[] = [];
  const pageNumbers: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    contentNumbers.push(4 + i * 2);
    pageNumbers.push(5 + i * 2);
  }

  const objects: string[] = [];
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageNumbers.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  for (let i = 0; i < pages.length; i++) {
    const content = contentFor(pages[i] as string[]);
    // object number N lives at index N-1
    objects[contentNumbers[i]! - 1] = `<< /Length ${latin1(content).length} >>\nstream\n${content}\nendstream`;
    objects[pageNumbers[i]! - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumbers[i]} 0 R >>`;
  }

  let out = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(latin1(out).length);
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = latin1(out).length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(latin1(out));
}
