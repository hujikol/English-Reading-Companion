/**
 * EPUB package parsing: container.xml -> OPF -> spine + navigation
 * (IDEA.md s8: parse OPF metadata, spine order, navigation).
 *
 * Deliberately narrow. Fixed-layout books are DETECTED and reported, not
 * rendered (v0.1 scope). Metadata is untrusted text: titles are used for
 * display only and are never used as locators.
 */

export type EpubPackage = {
  /** Path of the OPF inside the archive. */
  opfPath: string;
  title?: string;
  language?: string;
  /** Ordered spine items: idref resolved to an in-archive path. */
  spine: { id: string; href: string; linear: boolean }[];
  nav?: { href: string; items: { href: string; label: string }[] };
  /** Non-empty when the book must not be rendered. */
  unsupported?: { kind: "fixed-layout" };
};

/** Extract tag text from a fragment without a DOM. Sufficient for
 * container.xml and an OPF whose metadata section is well-formed. */
function tagText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!match) return undefined;
  const raw = (match[1] ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
  return raw === "" ? undefined : decodeXmlEntities(raw);
}

export function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attributes(tagText: string): Map<string, string> {
  const map = new Map<string, string>();
  const body = tagText.match(/^<\s*([a-zA-Z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)/);
  if (!body) return map;
  const attrSource = body[2] ?? "";
  const re = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrSource)) !== null) {
    map.set((m[1] ?? "").toLowerCase(), decodeXmlEntities(m[2] ?? m[3] ?? ""));
  }
  return map;
}

/** Resolve `href` relative to `base` and reject anything escaping the
 * archive root. Mirrors the ZIP path rules so a crafted OPF cannot point the
 * loader outside the validated file set. */
export function resolveArchivePath(base: string, href: string): string | null {
  const clean = href.split("#")[0] ?? "";
  if (clean === "" || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(clean) || clean.startsWith("//")) return null;
  const segments = (base === "" ? [] : base.split("/").slice(0, -1)).concat(clean.split("/"));
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/") || null;
}

export function readContainerPath(containerXml: string): string | null {
  const rootfile = /<rootfile\b[^>]*>/i.exec(containerXml);
  if (!rootfile) return null;
  const href = attributes(rootfile[0]).get("full-path");
  return href ?? null;
}

export type ParsePackageInput = {
  containerXml: string;
  /** Archive entry reader. Returns null when the path is not in the archive. */
  read(path: string): string | null;
};

export type ParsePackageResult =
  | { ok: true; pkg: EpubPackage }
  | { ok: false; reason: "damaged" | "unsupported"; detail: string };

/** Parse the OPF package document. Spine order is preserved exactly. */
export function parsePackage({ containerXml, read }: ParsePackageInput): ParsePackageResult {
  const opfPath = readContainerPath(containerXml);
  if (opfPath === null) return { ok: false, reason: "damaged", detail: "container.xml has no rootfile full-path" };
  if (resolveArchivePath("", opfPath) === null) {
    return { ok: false, reason: "damaged", detail: `OPF path escapes the archive: ${opfPath}` };
  }
  const opf = read(opfPath);
  if (opf === null) return { ok: false, reason: "damaged", detail: `OPF missing from archive: ${opfPath}` };

  if (/rendition:layout[= ]/i.test(opf) && /pre-paginated/i.test(opf)) {
    // Reported, not rendered (s8 v0.1 scope).
    const metadata = { opfPath, spine: [] as { id: string; href: string; linear: boolean }[] };
    return { ok: true, pkg: { ...metadata, unsupported: { kind: "fixed-layout" } } };
  }

  const title = tagText(opf, "dc:title") ?? tagText(opf, "title");
  const language = tagText(opf, "dc:language");

  const manifest = new Map<string, string>();
  const manifestRe = /<item\b[^>]*>/gi;
  let item: RegExpExecArray | null;
  while ((item = manifestRe.exec(opf)) !== null) {
    const attrs = attributes(item[0]);
    const id = attrs.get("id");
    const href = attrs.get("href");
    if (id !== undefined && href !== undefined) manifest.set(id, href);
  }

  const spine: { id: string; href: string; linear: boolean }[] = [];
  const spineRe = /<itemref\b[^>]*>/gi;
  let ref: RegExpExecArray | null;
  while ((ref = spineRe.exec(opf)) !== null) {
    const attrs = attributes(ref[0]);
    const idref = attrs.get("idref");
    if (idref === undefined) continue;
    const href = manifest.get(idref);
    if (href === undefined) continue;
    const resolved = resolveArchivePath(opfPath, href);
    if (resolved === null) continue;
    spine.push({ id: idref, href: resolved, linear: attrs.get("linear") !== "no" });
  }

  const navId = /<item\b[^>]*properties=["'][^"']*\bnav\b[^"']*["'][^>]*>/i.exec(opf)?.[0];
  const navHref = navId === undefined ? undefined : attributes(navId).get("href");
  const navPath = navHref === undefined ? null : resolveArchivePath(opfPath, navHref);

  const pkg: EpubPackage = {
    opfPath,
    spine,
    ...(title === undefined ? {} : { title }),
    ...(language === undefined ? {} : { language }),
  };
  const navXhtml = navPath === null ? null : read(navPath);
  if (navPath !== null && navXhtml !== null) {
    pkg.nav = { href: navPath, items: readNav(navXhtml) };
  }
  if (spine.length === 0) return { ok: false, reason: "damaged", detail: "spine is empty" };
  return { ok: true, pkg };
}

/** Nav labels come from untrusted text; keep them for display only. */
function readNav(xhtml: string | null): { href: string; label: string }[] {
  if (xhtml === null) return [];
  const items: { href: string; label: string }[] = [];
  const re = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xhtml)) !== null) {
    const href = decodeXmlEntities(m[1] ?? m[2] ?? "");
    if (href === "" || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) continue;
    const label = decodeXmlEntities((m[3] ?? "").replace(/<[^>]*>/g, "")).trim();
    if (label === "") continue;
    items.push({ href, label });
  }
  return items;
}
