/**
 * Container -> OPF -> reading order (IDEA.md s8).
 *
 * Pure: text in, reading order out. No fflate here, no DOM. The caller supplies
 * `readText`, which is where inflation and the per-section byte budget live
 * (see `renderer.tsx`), so this module can be exercised on any text pair.
 *
 * The layer under it is `package.ts` (Track D): OPF structure, spine order, nav
 * and fixed-layout detection are parsed there, not re-implemented here. What
 * this module adds is the three things a renderer needs and `EpubPackage` does
 * not carry:
 *
 *  1. PERCENT-DECODED hrefs. Real books ship `Text/ch%C3%A4pter%201.xhtml`, and
 *     a path that does not match the ZIP entry name is a chapter that silently
 *     fails to open. Decoding happens BEFORE path resolution, so a decoded
 *     `../` still has to survive `resolveArchivePath` and the entry-set
 *     membership check to reach a section.
 *  2. MEDIA TYPES per manifest item, which is what selects the stylesheets to
 *     inline (`css.ts`). This is a different projection of the same `<item>`
 *     elements, not a second spine parse.
 *  3. The READING ORDER as an explicit list, separating `linear="no"`
 *     supplementary documents from the sequence a reader pages through.
 *
 * Every path that reaches a section is checked against the validated entry set.
 * That check is the real security boundary: `zip-validate.ts` already rejected
 * traversal, absolute and encrypted entries, so "is this name in the archive?"
 * is the only question left before bytes are inflated.
 */

import { decodeXmlEntities, parsePackage, readContainerPath, resolveArchivePath } from "./package.ts";

export type ManifestItem = {
  id: string;
  /** percent-decoded, resolved, archive-root-relative */
  href: string;
  mediaType: string;
  properties: string[];
  /** stylesheet, nav document, cover image… display only */
  role: "stylesheet" | "nav" | "cover" | "other";
};

export type EpubChapter = {
  /** in-archive path; this is the stable spine identity used in locators */
  spineHref: string;
  idref: string;
  /** position in the declared spine, 0-based, including non-linear items */
  index: number;
  title?: string;
  linear: boolean;
  mediaType: string;
};

export type EpubNav = { href: string; items: { href: string; label: string }[] };

export type EpubBook = {
  opfPath: string;
  title?: string;
  language?: string;
  manifest: Record<string, ManifestItem>;
  /** declared spine order, exactly as the OPF lists it */
  chapters: EpubChapter[];
  /** indices into `chapters` that a reader pages through, in order */
  readingOrder: number[];
  nav?: EpubNav;
  /** spine itemrefs whose idref is not in the manifest (malformed, not fatal) */
  danglingIdrefs: number;
};

export type ReadEpubInput = {
  containerXml: string;
  /** Text of one archive entry, or null when it is not in the archive. The
   *  caller owns inflation and its byte budget. */
  readText: (path: string) => string | null;
  /** Validated entry names. When given, a resolved path that is not a member is
   *  dropped: the OPF cannot invent a file the ZIP does not contain. */
  entryNames?: ReadonlySet<string>;
};

export type ReadEpubResult =
  | { ok: true; book: EpubBook }
  | { ok: false; reason: "damaged" | "fixed-layout"; detail: string };

/**
 * Percent-decode the href-ish attribute values in an XML document.
 *
 * Runs before parsing so `parsePackage` sees real paths. Safety: only `<`, `>`
 * and `"` are re-escaped afterwards. `&` is deliberately left alone — the source
 * already contains well-formed entities (`&amp;` in `a&amp;b.xhtml`) and
 * re-escaping it would corrupt them; a decoded `%26` that produced a bare `&`
 * yields a filename that fails the entry-set check rather than a new attribute.
 * Without the `<`/`"` escaping, a `%22` could close the attribute and inject
 * markup, so this is not cosmetic.
 */
export function decodeHrefAttributes(xml: string): string {
  return xml.replace(
    /((?:href|full-path)\s*=\s*")([^"]*)(")/gi,
    (whole, open: string, value: string, close: string) => {
      let decoded = value;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        // A malformed escape is left as-is: it will not match an entry name.
      }
      const safe = decoded.replace(/</g, "%3C").replace(/>/g, "%3E").replace(/"/g, "%22");
      return safe === value ? whole : `${open}${safe}${close}`;
    },
  );
}

const ATTR_ANY = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributesOf(tagSource: string): Record<string, string> {
  const out: Record<string, string> = {};
  let match: RegExpExecArray | null;
  ATTR_ANY.lastIndex = 0;
  while ((match = ATTR_ANY.exec(tagSource)) !== null) {
    const name = (match[1] ?? "").toLowerCase();
    out[name] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  }
  return out;
}

/** One projection of the manifest: media types, so CSS can be chosen. */
export function readManifest(opfXml: string, opfPath: string): Record<string, ManifestItem> {
  const manifest: Record<string, ManifestItem> = {};
  const items = /<item\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = items.exec(opfXml)) !== null) {
    const attrs = attributesOf(match[0]);
    const id = attrs["id"];
    const rawHref = attrs["href"];
    if (id === undefined || id === "" || rawHref === undefined || rawHref === "") continue;
    const href = resolveArchivePath(opfPath, rawHref);
    if (href === null) continue;
    const mediaType = (attrs["media-type"] ?? "").toLowerCase();
    const properties = (attrs["properties"] ?? "")
      .split(/\s+/)
      .filter((p) => p !== "");
    manifest[id] = {
      id,
      href,
      mediaType,
      properties,
      role: mediaType === "text/css"
        ? "stylesheet"
        : properties.includes("nav")
          ? "nav"
          : properties.includes("cover-image")
            ? "cover"
            : "other",
    };
  }
  return manifest;
}

const XHTML_TYPES = new Set(["application/xhtml+xml", "text/html", "application/xml", "text/xml"]);

/** A spine item is a readable document only if it declares XHTML/HTML. */
export function isReflowable(mediaType: string, href: string): boolean {
  if (mediaType !== "") return XHTML_TYPES.has(mediaType);
  // A manifest item with no media-type at all is malformed but common in
  // hand-made EPUBs; the extension is the only remaining evidence.
  return /\.(xhtml|html|htm)$/i.test(href);
}

const stripTags = (html: string): string => decodeXmlEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/**
 * Nav labels keyed by spine href.
 *
 * A nav document's hrefs are relative to the nav document, but plenty of
 * producers write them relative to the OPF or already root-relative. Rather
 * than guess a base, each candidate is tried against the validated entry set
 * and the one that names a real file wins. `entryNames` is what makes that
 * decidable instead of a coin toss.
 */
function titlesFromNav(
  nav: EpubNav | undefined,
  opfPath: string,
  entryNames: ReadonlySet<string> | undefined,
): Map<string, string> {
  const titles = new Map<string, string>();
  if (nav === undefined) return titles;
  const known = (path: string | null): boolean => path !== null && (entryNames === undefined || entryNames.has(path));
  for (const item of nav.items) {
    if (item.label === "") continue;
    const candidates = [resolveArchivePath(nav.href, item.href), resolveArchivePath(opfPath, item.href)];
    const hit = candidates.find((c) => known(c));
    const chosen = hit ?? candidates.find((c) => c !== null);
    if (chosen === null || chosen === undefined) continue;
    if (!titles.has(chosen)) titles.set(chosen, item.label);
  }
  return titles;
}

/**
 * Fixed-layout detection.
 *
 * s8 scopes v0.1 to reflowable books, so a pre-paginated book is reported
 * rather than rendered as if it were text. Both spellings are checked: the EPUB 3
 * `rendition:layout` metadata property and the EPUB 2 `fixed-layout` meta name.
 */
export function detectFixedLayout(opfXml: string): boolean {
  if (/<meta\b[^>]*\bproperty\s*=\s*["']rendition:layout["'][^>]*>\s*pre-paginated/i.test(opfXml)) return true;
  if (/<meta\b[^>]*\bname\s*=\s*["']fixed-layout["'][^>]*\bcontent\s*=\s*["'](?:true|yes)["']/i.test(opfXml)) return true;
  return /\brendition:layout\s*[=:]>?\s*pre-paginated/i.test(opfXml);
}

/** `idref` values the OPF's spine declares, in order. */
function spineIdrefs(opfXml: string): string[] {
  const out: string[] = [];
  const re = /<itemref\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(opfXml)) !== null) {
    const idref = attributesOf(match[0])["idref"];
    if (idref !== undefined && idref !== "") out.push(idref);
  }
  return out;
}

const XML_DECL = /<\?xml[^>]*\?>/i;

/**
 * Read container.xml -> OPF -> reading order.
 *
 * `entryNames` is optional so this can be unit-tested on text alone; the
 * renderer always supplies it.
 */
export function readEpub({ containerXml, readText, entryNames }: ReadEpubInput): ReadEpubResult {
  const opfPath = readContainerPath(decodeHrefAttributes(containerXml));
  if (opfPath === null) return { ok: false, reason: "damaged", detail: "container.xml declares no rootfile full-path" };
  if (entryNames !== undefined && !entryNames.has(opfPath)) {
    return { ok: false, reason: "damaged", detail: `OPF path is not an archive entry: ${opfPath}` };
  }

  const rawOpf = readText(opfPath);
  if (rawOpf === null) return { ok: false, reason: "damaged", detail: `OPF missing from the archive: ${opfPath}` };

  // Percent-decode hrefs before the structural parse so spine hrefs resolve to
  // the same strings the ZIP entry names use.
  const opf = decodeHrefAttributes(rawOpf).replace(XML_DECL, "");
  const parsed = parsePackage({ containerXml: decodeHrefAttributes(containerXml), read: (path) => (path === opfPath ? opf : readText(path)) });
  if (!parsed.ok) return { ok: false, reason: "damaged", detail: parsed.detail };
  const pkg = parsed.pkg;
  if (pkg.unsupported !== undefined || detectFixedLayout(opf)) {
    return { ok: false, reason: "fixed-layout", detail: "this book is fixed-layout; v0.1 renders reflowable books only" };
  }

  const manifest = readManifest(opf, opfPath);
  const nav: EpubNav | undefined =
    pkg.nav === undefined ? undefined : { href: pkg.nav.href, items: pkg.nav.items.map((i) => ({ ...i })) };
  const navTitles = titlesFromNav(nav, opfPath, entryNames);

  const chapters: EpubChapter[] = [];
  const readingOrder: number[] = [];
  let danglingIdrefs = 0;

  for (const item of pkg.spine) {
    const declared = manifest[item.id];
    if (declared === undefined) {
      danglingIdrefs += 1;
      continue;
    }
    // The OPF's word for the path loses to the manifest's: the manifest is what
    // the ZIP entry names were checked against.
    const spineHref = declared.href;
    if (entryNames !== undefined && !entryNames.has(spineHref)) {
      danglingIdrefs += 1;
      continue;
    }
    if (!isReflowable(declared.mediaType, spineHref)) continue;
    const index = chapters.length;
    const navTitle = navTitles.get(spineHref);
    const chapter: EpubChapter = {
      spineHref,
      idref: item.id,
      index,
      linear: item.linear,
      mediaType: declared.mediaType,
      ...(navTitle === undefined ? {} : { title: navTitle }),
    };
    chapters.push(chapter);
    if (item.linear) readingOrder.push(index);
  }

  // An itemref pointing at no manifest item is a malformed spine, not a fatal
  // error, but it must be counted rather than silently dropped.
  for (const idref of spineIdrefs(opf)) if (manifest[idref] === undefined) danglingIdrefs += 1;

  if (chapters.length === 0) {
    return { ok: false, reason: "damaged", detail: "the spine contains no reflowable document present in the archive" };
  }
  // A book that marks everything non-linear still has a reading order: its
  // declared spine sequence. Dropping it would leave a readable book unreadable.
  const order = readingOrder.length > 0 ? readingOrder : chapters.map((c) => c.index);

  return {
    ok: true,
    book: {
      opfPath,
      manifest,
      chapters,
      readingOrder: order,
      danglingIdrefs,
      ...(pkg.title === undefined ? {} : { title: pkg.title }),
      ...(pkg.language === undefined ? {} : { language: pkg.language }),
      ...(nav === undefined ? {} : { nav }),
    },
  };
}

/** Manifest stylesheets, in manifest order. */
export function stylesheetHrefs(book: EpubBook): string[] {
  return Object.values(book.manifest)
    .filter((item) => item.role === "stylesheet")
    .map((item) => item.href);
}

/** `Chapter 4` style label for display only; never a locator. */
export const chapterLabel = (chapter: EpubChapter, fallbackIndex: number): string =>
  chapter.title ?? `Section ${fallbackIndex + 1}`;

/** Plain text of a chapter's markup, for the reader's own previews. */
export const textOf = stripTags;
