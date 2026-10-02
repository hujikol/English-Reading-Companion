/**
 * Emit a small, real EPUB for manual verification.
 *
 * The test suite builds EPUBs in memory, which proves the parser handles them
 * but leaves nothing to open in a browser. This writes one to disk so the
 * reading path can be exercised by hand: chapter navigation, the book's own
 * CSS, text selection into a mark, and the lookup card on a word the shipped
 * dictionary actually contains.
 *
 *   npm run sample:epub        # -> public/sample/sample-book.epub
 *
 * The prose deliberately leans on words the shipped pack contains (verified
 * against it: ferry, narrow, surface, time, water, crossing all resolve) so
 * selecting one shows a real gloss. Some everyday words are absent — "quiet",
 * "light", "harbour" have no Indonesian translation upstream — so a miss is
 * equally easy to exercise, and the card offers to save the word instead.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync, strToU8, type Zippable } from "fflate";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", "public", "sample", "sample-book.epub");

const utf8 = (s: string) => strToU8(s);

const page = (title: string, body: string) => `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>${body}</body>
</html>`;

const STYLE = `body{font-family:Georgia,"Times New Roman",serif;line-height:1.6;margin:1.2em}
h1{font-size:1.4em;margin:0 0 .6em}
p{text-indent:1.2em;margin:0 0 .8em}
blockquote{margin-left:2em;font-style:italic}`;

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const opf = (manifest: string, spine: string) => `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">erc-sample-0001</dc:identifier>
    <dc:title>The Crossing</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>English Reading Companion</dc:creator>
  </metadata>
  <manifest>${manifest}</manifest>
  <spine>${spine}</spine>
</package>`;

const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <ol>
      <li><a href="ch1.xhtml">The Crossing</a></li>
      <li><a href="ch2.xhtml">Rain</a></li>
      <li><a href="ch3.xhtml">Flat Water</a></li>
    </ol>
  </nav>
</body>
</html>`;

const ch1 = page(
  "The Crossing",
  `<h1>The Crossing</h1>
   <p>The ferry left the harbour at dawn, and the water was quiet for a long time.</p>
   <p>She watched the narrow light on the surface and did not speak.</p>
   <blockquote>The tide had already begun to turn.</blockquote>`,
);

const ch2 = page(
  "Rain",
  `<h1>Rain</h1>
   <p>Rain arrived before the lighthouse, and the wind began to drift across the deck.</p>
   <p>He counted the time until the light came back.</p>`,
);

const ch3 = page(
  "Flat Water",
  `<h1>Flat Water</h1>
   <p>By noon the water had gone flat, and the harbour was quiet again.</p>
   <p>It was a small thing, but she remembered it for a long time.</p>`,
);

const MANIFEST = [
  `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
  `<item id="css" href="style.css" media-type="text/css"/>`,
  `<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>`,
  `<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>`,
  `<item id="c3" href="ch3.xhtml" media-type="application/xhtml+xml"/>`,
].join("");

const SPINE = `<itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/>`;

const files: Zippable = {
  // The one EPUB-specific ZIP rule: mimetype first, stored (level 0).
  mimetype: [utf8("application/epub+zip"), { level: 0 }],
  "META-INF/container.xml": utf8(CONTAINER),
  "OEBPS/content.opf": utf8(opf(MANIFEST, SPINE)),
  "OEBPS/nav.xhtml": utf8(nav),
  "OEBPS/style.css": utf8(STYLE),
  "OEBPS/ch1.xhtml": utf8(ch1),
  "OEBPS/ch2.xhtml": utf8(ch2),
  "OEBPS/ch3.xhtml": utf8(ch3),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, zipSync(files));
process.stdout.write(`wrote ${OUT} (${files && Object.keys(files).length} entries)\n`);
