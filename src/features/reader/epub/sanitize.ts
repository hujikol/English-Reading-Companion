/**
 * Sanitization policy for untrusted chapter XHTML and CSS (IDEA.md s8, s18).
 *
 * Pure: string in, string out. No dependency, no DOM.
 *
 * Design: output is REBUILT from an allowlist. Unknown tags, unknown
 * attributes and unknown URL schemes are dropped rather than filtered
 * through, so a construct nobody anticipated cannot survive by being
 * unrecognised. Text and attribute values are re-escaped, never passed
 * through verbatim.
 */

/**
 * The HTML void elements: they never have a closing tag and never have
 * content. This must be the FULL list, not just the ones we re-emit — a void
 * tag that reaches the drop-content branch looking for `</tag` would run to
 * end-of-document and eat the entire chapter.
 */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

/** Tags whose CONTENT is dropped along with the tag. Script/style bodies are
 * raw text, so their contents must be consumed, not re-emitted. */
const DROP_CONTENT_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "select",
  "option",
  "optgroup",
  "textarea",
  "label",
  "fieldset",
  "template",
  "svg",
  "math",
  "link",
  "meta",
  "base",
  "canvas",
  "audio",
  "video",
  "source",
  "track",
  "param",
  "portal",
  "map",
  "area",
]);

const ALLOWED_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code",
  "col", "colgroup", "data", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "i", "img", "ins", "kbd", "li", "main", "mark", "nav",
  "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section", "small", "span", "strong", "sub", "summary",
  "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
]);

/** Attributes permitted on every allowed element. `style` is handled
 * separately (sanitized as CSS), `on*` never is. */
const GLOBAL_ATTRS = new Set(["id", "class", "dir", "lang", "title"]);

const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "hreflang", "rel"]),
  img: new Set(["src", "alt", "width", "height", "decoding"]),
  td: new Set(["colspan", "rowspan", "headers"]),
  th: new Set(["colspan", "rowspan", "headers", "scope", "abbr"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start", "reversed", "type"]),
  time: new Set(["datetime"]),
  del: new Set(["datetime"]),
  ins: new Set(["datetime"]),
  blockquote: new Set(["cite"]),
  q: new Set(["cite"]),
};

const URL_ATTRS = new Set(["href", "src", "cite"]);

/** Schemes an `href` may keep. Everything else (javascript:, data:, file:,
 * blob:, custom schemes) is dropped. */
const SAFE_LINK_SCHEMES = new Set(["http", "https", "mailto"]);

/** `img src` additionally accepts `blob:`, because that is what the host's
 * own asset resolver hands back for a validated local file. The CSP still
 * decides which origins a blob may be read from. */
const SAFE_IMG_SCHEMES = new Set(["blob"]);

/** `srcset`/`ping`/`longdesc`/`usemap` are refused outright: they carry
 * unvalidated URLs outside the single-URL rewrite path. */
const REFUSED_ATTRS = new Set(["srcset", "ping", "longdesc", "usemap", "formaction", "srcdoc", "background", "dynsrc", "lowsrc"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
};

/** ponytail: numeric + a short named table. Full entity tables belong to a
 * real parser; unknown entities round-trip as literal text, which is safe. */
export function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body[1] === "x" || body[1] === "X";
      const digits = hex ? body.slice(2) : body.slice(1);
      const code = Number.parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

export function escapeText(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttribute(input: string): string {
  return escapeText(input).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Classify a URL after entity decoding and control-character stripping, which
 * is what a browser does before it decides on a scheme. */
export function classifyUrl(raw: string): { kind: "empty" | "fragment" | "relative" | "scheme"; scheme: string } {
  const cleaned = decodeEntities(raw).replace(/[\u0000-\u0020]/g, "");
  if (cleaned === "") return { kind: "empty", scheme: "" };
  if (cleaned.startsWith("#")) return { kind: "fragment", scheme: "" };
  const match = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(cleaned);
  if (!match) return { kind: "relative", scheme: "" };
  return { kind: "scheme", scheme: (match[1] ?? "").toLowerCase() };
}

/** CSS sanitization: comments removed, at-rules that fetch or bind dropped,
 * `url()` targets restricted to validated local assets. */
export function sanitizeCss(css: string): string {
  let out = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // url() first: rewriting an absolute target to about:invalid is stronger
  // than deleting the `data:` scheme and leaving a bogus relative URL behind.
  out = out.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, _q: string, target: string) => {
    // Only blob: survives, and only because the host minted it for a
    // validated local asset. Every other absolute or protocol-relative URL
    // would be a network fetch from book-supplied CSS.
    const verdict = classifyUrl(target);
    if (verdict.kind === "relative" || verdict.kind === "fragment") return whole;
    return verdict.kind === "scheme" && verdict.scheme === "blob" ? whole : "url(about:invalid)";
  });
  out = out.replace(/@import[^;}]*[;}]?/gi, "");
  out = out.replace(/@namespace[^;}]*[;}]?/gi, "");
  out = out.replace(/expression\s*\(([^()]|\([^()]*\))*\)/gi, "");
  out = out.replace(/(?:javascript|vbscript|data)\s*:/gi, "");
  out = out.replace(/(-moz-binding|behavior)\s*:[^;}]*;?/gi, "");
  return out;
}

export type SanitizeCounters = {
  droppedTags: number;
  droppedHandlers: number;
  blockedSchemes: number;
  remoteResources: number;
  droppedContentBlocks: number;
  rewrittenResources: number;
};

export type SanitizeOptions = {
  /** Refuse chapters longer than this many characters before parsing. */
  maxChars?: number;
  /**
   * Rewrites a validated relative resource href to a host-controlled local URL.
   * Return null to drop the reference. Only the resolver knows what is local.
   */
  resolveResource?: (href: string, tag: string) => string | null;
  /** Default true: http(s)/mailto links survive, hardened with rel. */
  allowExternalLinks?: boolean;
};

export type SanitizeResult =
  | { ok: true; html: string; counters: SanitizeCounters }
  | { ok: false; reason: "section-length"; detail: string };

const NAME_START = /[a-zA-Z]/;
const NAME_CHAR = /[a-zA-Z0-9._:-]/;

function readTagName(src: string, from: number): { name: string; end: number } | null {
  let i = from;
  if (i >= src.length || !NAME_START.test(src[i] ?? "")) return null;
  let name = "";
  while (i < src.length && NAME_CHAR.test(src[i] ?? "")) {
    name += src[i];
    i++;
  }
  return { name: name.toLowerCase(), end: i };
}

/** Find the `>` that closes a tag, ignoring `>` inside quoted values. */
function findTagEnd(src: string, from: number): number {
  let quote = "";
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

type Attr = { name: string; value: string | null };

function parseAttributes(src: string, start: number, end: number): Attr[] {
  const attrs: Attr[] = [];
  let i = start;
  while (i < end) {
    while (i < end && /[\s/]/.test(src[i] ?? "")) i++;
    if (i >= end) break;
    let name = "";
    while (i < end && !/[\s=/>]/.test(src[i] ?? "")) {
      name += src[i];
      i++;
    }
    if (name === "") {
      i++;
      continue;
    }
    while (i < end && /\s/.test(src[i] ?? "")) i++;
    let value: string | null = null;
    if (src[i] === "=") {
      i++;
      while (i < end && /\s/.test(src[i] ?? "")) i++;
      const quote = src[i];
      if (quote === '"' || quote === "'") {
        i++;
        let v = "";
        while (i < end && src[i] !== quote) {
          v += src[i];
          i++;
        }
        i++;
        value = v;
      } else {
        let v = "";
        while (i < end && !/\s/.test(src[i] ?? "")) {
          v += src[i];
          i++;
        }
        value = v;
      }
    }
    attrs.push({ name: name.toLowerCase(), value });
  }
  return attrs;
}

function counter(): SanitizeCounters {
  return {
    droppedTags: 0,
    droppedHandlers: 0,
    blockedSchemes: 0,
    remoteResources: 0,
    droppedContentBlocks: 0,
    rewrittenResources: 0,
  };
}

/**
 * Sanitize one chapter document. Returns rebuilt markup; on `ok:false` the
 * input was rejected before any parsing happened.
 */
export function sanitizeChapter(xhtml: string, options: SanitizeOptions = {}): SanitizeResult {
  const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY;
  if (xhtml.length > maxChars) {
    return { ok: false, reason: "section-length", detail: `chapter of ${xhtml.length} chars exceeds limit ${maxChars}` };
  }
  const resolveResource = options.resolveResource;
  const allowExternalLinks = options.allowExternalLinks ?? true;
  const counters = counter();
  const out: string[] = [];
  const open: string[] = [];
  let i = 0;

  const emitText = (chunk: string) => {
    if (chunk === "") return;
    out.push(escapeText(decodeEntities(chunk)));
  };

  while (i < xhtml.length) {
    const lt = xhtml.indexOf("<", i);
    if (lt < 0) {
      emitText(xhtml.slice(i));
      break;
    }
    emitText(xhtml.slice(i, lt));

    if (xhtml.startsWith("<!--", lt)) {
      const close = xhtml.indexOf("-->", lt);
      i = close < 0 ? xhtml.length : close + 3;
      counters.droppedTags++;
      continue;
    }
    if (xhtml.startsWith("<!", lt) || xhtml.startsWith("<?", lt)) {
      const end = findTagEnd(xhtml, lt + 2);
      i = end < 0 ? xhtml.length : end + 1;
      counters.droppedTags++;
      continue;
    }

    const closing = xhtml[lt + 1] === "/";
    const nameStart = lt + (closing ? 2 : 1);
    const parsedName = readTagName(xhtml, nameStart);
    if (!parsedName) {
      // A bare `<` in prose. Escaped, never treated as a tag.
      out.push("&lt;");
      i = lt + 1;
      continue;
    }
    const tagEnd = findTagEnd(xhtml, parsedName.end);
    if (tagEnd < 0) {
      emitText(xhtml.slice(lt));
      break;
    }
    const name = parsedName.name;

    if (closing) {
      if (DROP_CONTENT_TAGS.has(name)) {
        counters.droppedContentBlocks++;
      } else if (ALLOWED_TAGS.has(name)) {
        const at = open.lastIndexOf(name);
        if (at >= 0) {
          // Close anything left dangling inside, so emitted markup nests.
          for (let k = open.length - 1; k > at; k--) out.push(`</${open[k]}>`);
          open.length = at;
          out.push(`</${name}>`);
        }
      } else {
        counters.droppedTags++;
      }
      i = tagEnd + 1;
      continue;
    }

    const attrs = parseAttributes(xhtml, parsedName.end, tagEnd);
    const selfClosing = xhtml[tagEnd - 1] === "/";

    if (DROP_CONTENT_TAGS.has(name)) {
      counters.droppedTags++;
      counters.droppedContentBlocks++;
      // script/style hold raw text that must be consumed to a close tag, and so do
      // the container tags (iframe/object/etc.), whose fallback content must not
      // survive. VOID elements must NOT be treated this way: they never have a
      // close tag, so the search runs to end-of-document and eats the chapter.
      if (name === "script" || name === "style" || !VOID_TAGS.has(name)) {
        // Consume raw content up to the matching close tag.
        const closeTag = `</${name}`;
        const at = xhtml.toLowerCase().indexOf(closeTag, tagEnd + 1);
        if (at < 0) {
          i = xhtml.length;
        } else {
          const closeEnd = findTagEnd(xhtml, at + closeTag.length);
          i = closeEnd < 0 ? xhtml.length : closeEnd + 1;
        }
      } else {
        i = tagEnd + 1;
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(name)) {
      counters.droppedTags++;
      i = tagEnd + 1;
      continue;
    }

    const kept: string[] = [];
    for (const attr of attrs) {
      if (attr.name.startsWith("on")) {
        counters.droppedHandlers++;
        continue;
      }
      if (REFUSED_ATTRS.has(attr.name)) {
        counters.droppedTags++;
        continue;
      }
      const permitted =
        GLOBAL_ATTRS.has(attr.name) ||
        attr.name === "style" ||
        TAG_ATTRS[name]?.has(attr.name) === true;
      if (!permitted) {
        counters.droppedTags++;
        continue;
      }
      if (attr.name === "style") {
        if (attr.value === null) continue;
        const css = sanitizeCss(attr.value).trim();
        if (css === "") continue;
        kept.push(`style="${escapeAttribute(css)}"`);
        continue;
      }
      if (URL_ATTRS.has(attr.name)) {
        const raw = attr.value;
        if (raw === null) continue;
        const verdict = classifyUrl(raw);
        if (verdict.kind === "empty") continue;
        if (verdict.kind === "scheme") {
          // A remote RESOURCE is never permitted, however external links are
          // configured: allowing it would fetch a tracker pixel. Only blob:,
          // which the host itself mints for validated local assets, passes.
          if (attr.name === "src") {
            if (!SAFE_IMG_SCHEMES.has(verdict.scheme)) {
              counters.remoteResources++;
              continue;
            }
          } else if (!SAFE_LINK_SCHEMES.has(verdict.scheme) || (verdict.scheme !== "mailto" && !allowExternalLinks)) {
            counters.blockedSchemes++;
            continue;
          }
          kept.push(`${attr.name}="${escapeAttribute(raw.trim())}"`);
          if (name === "a") kept.push(`rel="${escapeAttribute('noopener noreferrer nofollow')}"`);
          continue;
        }
        if (verdict.kind === "fragment") {
          kept.push(`${attr.name}="${escapeAttribute(raw.trim())}"`);
          continue;
        }
        // Relative: only a validated local asset may survive.
        if (!resolveResource) {
          counters.remoteResources++;
          continue;
        }
        const rewritten = resolveResource(decodeEntities(raw).trim(), name);
        if (rewritten === null) {
          counters.remoteResources++;
          continue;
        }
        counters.rewrittenResources++;
        kept.push(`${attr.name}="${escapeAttribute(rewritten)}"`);
        if (name === "a") kept.push(`rel="${escapeAttribute('noopener noreferrer')}"`);
        continue;
      }
      kept.push(`${attr.name}="${escapeAttribute(attr.value ?? "")}"`);
    }

    out.push(`<${name}${kept.length ? ` ${kept.join(" ")}` : ""}>`);
    if (!VOID_TAGS.has(name) && !selfClosing) open.push(name);
    i = tagEnd + 1;
  }

  while (open.length) out.push(`</${open.pop() ?? ""}>`);
  return { ok: true, html: out.join(""), counters };
}
