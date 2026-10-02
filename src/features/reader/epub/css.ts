/**
 * Chapter CSS: collect, inline, sanitize (IDEA.md s8).
 *
 * Pure. `readText`/`readBytes` are injected, so the whole module is testable on
 * a text map with no archive and no DOM.
 *
 * The order of operations is the security-relevant part:
 *
 *  1. Collect candidate stylesheets from the OPF manifest and from the chapter's
 *     own `<link rel="stylesheet">`. The chapter's links are read from the RAW
 *     XHTML, because `sanitizeChapter` drops `<link>` entirely — collecting after
 *     sanitization would silently discard every chapter-local stylesheet.
 *  2. Resolve each href against the archive root and require it to be a member
 *     of the validated entry set. A stylesheet the ZIP does not contain is not
 *     fetched from anywhere; it is dropped.
 *  3. Inline `@import` of LOCAL stylesheets by recursion (bounded depth and
 *     count), because `sanitizeCss` deletes `@import` outright and a linearized
 *     book that styles half its chapters through `@import` would render unstyled.
 *     A remote `@import` is not inlined and is then removed by `sanitizeCss`.
 *  4. Run every surviving byte through `sanitizeCss`, then rewrite `url()`
 *     targets through the caller's local-asset resolver. Local assets become
 *     blob URLs the host minted; everything else becomes `about:invalid`.
 *  5. Prepend the reader's own typography from `Appearance`, so reader
 *     controls win over book CSS without either being discarded.
 *
 * Nothing here produces a URL the browser would fetch from the network: after
 * step 4 the only `url()` targets that survive are ones `resolveAsset` returned.
 */

import { sanitizeCss } from "./sanitize.ts";
import { stylesheetHrefs, type EpubBook, type EpubChapter } from "./opf.ts";
import { DEFAULT_APPEARANCE, type Appearance } from "./adapter.ts";

export const CSS_LIMITS = {
  /** Total CSS bytes inlined for one chapter. */
  maxTotalBytes: 512 * 1024,
  /** One stylesheet. */
  maxFileBytes: 256 * 1024,
  /** `@import` nesting depth. */
  maxImportDepth: 4,
  /** `@import` statements followed across all stylesheets for one chapter. */
  maxImports: 32,
} as const;

export type CssInput = {
  book: EpubBook;
  chapter: EpubChapter;
  /** raw, unsanitized chapter XHTML — read for its <link rel=stylesheet> */
  chapterXhtml: string;
  readText: (path: string) => string | null;
  /** Validated entry names. Nothing outside this set is ever read. */
  entryNames: ReadonlySet<string>;
  /**
   * Turns an in-archive asset path into a URL the frame may load, normally a
   * blob the host minted. Return null to drop the reference.
   */
  resolveAsset?: (path: string) => string | null;
  appearance?: Appearance;
};

export type ChapterCss = {
  /** ready to hand to `chapterFramePolicy` as its sanitizedCss argument */
  css: string;
  /** stylesheets that contributed, in the order they were inlined */
  sources: string[];
  /** stylesheet hrefs that were dropped, with the reason */
  dropped: { href: string; reason: string }[];
  bytes: number;
};

const LINK_STYLESHEET = /<link\b[^>]*>/gi;
const ATTR = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attr(tag: string, name: string): string | undefined {
  ATTR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR.exec(tag)) !== null) {
    if ((match[1] ?? "").toLowerCase() === name) return match[2] ?? match[3] ?? "";
  }
  return undefined;
}

/** Local stylesheet hrefs a chapter links itself, in document order. */
export function chapterLinkHrefs(xhtml: string): string[] {
  const out: string[] = [];
  LINK_STYLESHEET.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINK_STYLESHEET.exec(xhtml)) !== null) {
    const rel = (attr(match[0], "rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("stylesheet")) continue;
    const href = attr(match[0], "href");
    if (href === undefined || href.trim() === "") continue;
    out.push(href.trim());
  }
  return out;
}

const IMPORT = /@import\s+(?:url\(\s*(['"]?)([^'")]*)\1\s*\)|(['"])([^'"]*)\3)\s*([^;}]*)[;}]?/gi;

/** `@import` targets in one stylesheet, in source order. */
export function importTargets(css: string): string[] {
  const out: string[] = [];
  IMPORT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT.exec(css)) !== null) {
    const target = (match[2] ?? match[4] ?? "").trim();
    if (target !== "") out.push(target);
  }
  return out;
}

/** Same relative-path arithmetic as `opf.ts`, kept local to avoid a cycle. */
function resolveRelative(base: string, href: string): string | null {
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

const URL_FN = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/**
 * Rewrite `url()` targets. Relative ones become whatever `resolveAsset` mints
 * for the in-archive path; anything the resolver declines, and every absolute
 * URL, becomes `about:invalid`. `sanitizeCss` has already run, so this pass only
 * has to close the relative-reference hole it deliberately leaves open.
 */
export function rewriteCssUrls(css: string, base: string, resolveAsset?: (path: string) => string | null): string {
  if (resolveAsset === undefined) return css.replace(URL_FN, () => "url(about:invalid)");
  return css.replace(URL_FN, (whole, _q: string, rawTarget: string) => {
    const target = rawTarget.trim();
    if (target === "") return "url(about:invalid)";
    if (target.startsWith("#")) return whole;
    const resolved = resolveRelative(base, target);
    if (resolved === null) return "url(about:invalid)";
    const url = resolveAsset(resolved);
    return url === null ? "url(about:invalid)" : `url("${url.replace(/["\\]/g, "\\$&")}")`;
  });
}

const THEMES: Record<Appearance["theme"], { bg: string; fg: string }> = {
  light: { bg: "#ffffff", fg: "#1a1a1a" },
  dark: { bg: "#14161a", fg: "#e8eaed" },
  sepia: { bg: "#f4ecd8", fg: "#3b2f21" },
};

/** Reader-controlled typography, emitted first so book CSS cannot shrink it away. */
export function appearanceCss(appearance: Appearance = DEFAULT_APPEARANCE): string {
  const { bg, fg } = THEMES[appearance.theme];
  const family = appearance.fontFamily.replace(/[<>{};]/g, "");
  return [
    `html{font-size:${Math.round(appearance.fontSizePx)}px}`,
    `body{font-family:${family};line-height:${appearance.lineHeight};color:${fg};background:${bg};` +
      `padding:${Math.round(appearance.marginPx)}px;max-width:38em;margin:0 auto}`,
  ].join("");
}

/**
 * Gather one chapter's CSS. Deterministic order: reader typography, then
 * manifest stylesheets in manifest order, then the chapter's own links in
 * document order, each with its local `@import`s inlined before it.
 */
export function chapterCss(input: CssInput): ChapterCss {
  const { book, chapter, chapterXhtml, readText, entryNames, resolveAsset, appearance } = input;
  const dropped: { href: string; reason: string }[] = [];
  const sources: string[] = [];
  /** One entry per top-level stylesheet, imports already inlined into it. */
  const blocks: string[] = [];
  let bytes = 0;
  let importsLeft = CSS_LIMITS.maxImports;
  const seen = new Set<string>();

  const collect = (href: string, base: string, depth: number): void => {
    if (bytes >= CSS_LIMITS.maxTotalBytes) {
      dropped.push({ href, reason: "chapter CSS budget exhausted" });
      return;
    }
    const path = resolveRelative(base, href);
    if (path === null) {
      dropped.push({ href, reason: "not a local archive path" });
      return;
    }
    if (!entryNames.has(path)) {
      dropped.push({ href, reason: "not present in the archive" });
      return;
    }
    if (seen.has(path)) return; // @import cycle
    seen.add(path);

    const text = readText(path);
    if (text === null) {
      dropped.push({ href, reason: "could not be read" });
      return;
    }
    if (text.length > CSS_LIMITS.maxFileBytes) {
      dropped.push({ href, reason: `larger than ${CSS_LIMITS.maxFileBytes} bytes` });
      return;
    }

    // `@import` first: CSS requires an imported sheet's rules to precede the
    // importing sheet's, so the recursion has to push before `own`.
    if (importsLeft > 0 && depth < CSS_LIMITS.maxImportDepth) {
      for (const target of importTargets(text)) {
        if (importsLeft <= 0) {
          dropped.push({ href: target, reason: "import count limit" });
          continue;
        }
        importsLeft -= 1;
        collect(target, path, depth + 1);
      }
    } else {
      for (const target of importTargets(text)) dropped.push({ href: target, reason: "import depth limit" });
    }
    const own = text.replace(IMPORT, "");
    const block = appearanceCss(appearance) + sanitizeCss(rewriteCssUrls(sanitizeCss(own), path, resolveAsset));
    bytes += block.length;
    sources.push(path);
    // Pushed at EVERY depth, not just the top: the recursion above already ran,
    // so an imported sheet's rules land before its importer's, which is the
    // order the cascade requires. Pushing only depth 0 would collect base.css
    // and then silently throw its rules away.
    blocks.push(block);
  };

  for (const href of stylesheetHrefs(book)) collect(href, book.opfPath, 0);
  for (const href of chapterLinkHrefs(chapterXhtml)) collect(href, chapter.spineHref, 0);

  return { css: blocks.join("\n"), sources, dropped, bytes };
}
