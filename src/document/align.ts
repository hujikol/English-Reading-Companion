/**
 * Section 7 PDF alignment procedure. Geometry-free: the WASM wrapper has no
 * positioned API and none is invented here (ADR 004).
 *
 *   1. read the selected PDF.js text and its page identity
 *   2. normalize whitespace, ligatures and apostrophe variants for MATCHING,
 *      retaining the original text and an offset mapping
 *   3. search only relevant semantic pages
 *   4. resolve repeated phrases using quote prefix/suffix and neighbouring text
 *   5. accept semantic sentence context only when the match is UNIQUE or passes
 *      the tested disambiguation rule
 *   6. if ambiguous, use the exact selection or verified PDF.js context. Label
 *      missing context rather than guessing
 *
 * Five rules that keep this honest, each with a test:
 * - Match space is a normalized SPACE, never "". "the cat" must not match
 *   "the catalog", so a match also has to land on word boundaries.
 * - A page is normalized BLOCK BY BLOCK and rejoined with a blank line. That
 *   keeps the block walls intact: a needle cannot span a column break, a header,
 *   a footer or a table cell, no matter how close the strings are.
 * - A repeated phrase is ambiguous even when every copy sits in one block.
 *   "Unique" means one occurrence, not one block.
 * - Line-end hyphenation is reversed ONLY when the de-hyphenated form is present
 *   in the same page. A needle ENDING in a hyphen is never guessed, because the
 *   continuation is unknown.
 * - Mapped offsets land on the LAST matched character, so a match that stops
 *   before a space does not swallow that space.
 */

import { REPLACEMENT_CHAR } from "./quality.ts";

export type NormalizedText = {
  /** normalized, for matching only — never shown to a reader or stored */
  normalized: string;
  /** the transliterated source that offsets in `map` index into */
  source: string;
  /** normalized offset -> source offset. Length is normalized.length + 1. */
  map: Int32Array;
};

/** Ligatures, apostrophes, quotes, dashes, exotic spaces. Real hyphen stays "-". */
const MATCH_TRANSLITERATE: Array<[RegExp, string]> = [
  [/ﬀ/g, "ff"],
  [/ﬁ/g, "fi"],
  [/ﬂ/g, "fl"],
  [/ﬃ/g, "ffi"],
  [/ﬄ/g, "ffl"],
  [/ﬆ/g, "st"],
  [/ß/g, "ss"],
  [/['‘’‚‛′ʼ]/g, "'"],
  [/["“”„‟″]/g, '"'],
  [/[‐‑‒–—―−]/g, "-"],
  [/[   -   　]/g, " "],
];

/** Soft hyphen, zero-width space/joiners, word joiner, BOM. */
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

/** Block wall. Normalizing never produces this inside a block. */
const BLOCK_WALL = "\n\n";

export const NORMALIZE_VERSION = "match-normalizer@2";

/**
 * Build the normalized matching form and its offset map. Whitespace runs inside
 * the text collapse to one space; leading and trailing whitespace is dropped so
 * a selection starting mid-line still matches.
 */
export function normalizeForMatch(text: string): NormalizedText {
  let s = (text ?? "").replace(INVISIBLE, "");
  for (const [re, to] of MATCH_TRANSLITERATE) s = s.replace(re, to);

  const out: string[] = [];
  const map: number[] = [];
  let pendingSpace = false;
  let spaceAt = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      if (out.length > 0) {
        pendingSpace = true;
        spaceAt = i;
      }
      continue;
    }
    if (pendingSpace) {
      // The collapsed space maps to the FIRST whitespace character it stands
      // for. Mapping it to `i` (the following character) shifted every later
      // offset by one and made an end offset land before the last matched char.
      out.push(" ");
      map.push(spaceAt!);
      pendingSpace = false;
    }
    out.push(ch);
    map.push(i);
  }
  // Sentinel: maps the position just past the last normalized character.
  map.push(s.length);
  return { normalized: out.join(""), source: s, map: Int32Array.from(map) };
};

/** Source offset for a normalized offset, clamped into range. */
export const toOriginalOffset = (n: NormalizedText, normalizedOffset: number): number => {
  const i = Math.max(0, Math.min(n.map.length - 1, normalizedOffset));
  return n.map[i]!;
};

/**
 * Source range for a normalized [start, end) match. The end comes from the LAST
 * matched character, so a match that stops before a space does not swallow it.
 */
export const toOriginalRange = (n: NormalizedText, start: number, end: number): { start: number; end: number } => {
  const startOffset = toOriginalOffset(n, start);
  if (end <= 0) return { start: startOffset, end: startOffset };
  const last = toOriginalOffset(n, end - 1);
  return { start: startOffset, end: last + (n.source[last] ?? "").length };
};

export type SemanticPageInput = {
  pageIndex: number;
  text: string;
  /** [start, end) ranges of each block. Blocks are not joinable. */
  blocks: ReadonlyArray<{ start: number; end: number }>;
};

/** A page whose normalized form is built once per mount and reused per mark. */
export type IndexedPage = SemanticPageInput & { normalized: NormalizedText };

/**
 * Normalize one page, block by block, rejoining with a blank line so the block
 * walls survive normalization. A phrase cannot be found across a wall because
 * no normalized needle can contain one.
 */
export const indexPage = (page: SemanticPageInput): IndexedPage => {
  const { text } = page;
  const blocks = page.blocks.length > 0 ? page.blocks : [{ start: 0, end: text.length }];
  const parts: string[] = [];
  const map: number[] = [];

  blocks.forEach((b, i) => {
    if (i > 0) {
      // The wall belongs to no block, so it maps to the boundary. Pointing it at
      // b.start + 1 made the map non-monotonic and stole the following block's
      // first character, which shifted every offset in that block by one.
      parts.push(BLOCK_WALL);
      map.push(b.start, b.start);
    }
    const n = normalizeForMatch(text.slice(b.start, b.end));
    parts.push(n.normalized);
    // Drop this block's trailing sentinel: the joined form carries ONE sentinel
    // at the very end. Keeping every block's sentinel made map.length exceed
    // normalized.length and shifted each block boundary's offsets.
    for (let k = 0; k < n.map.length - 1; k++) map.push(b.start + n.map[k]!);
  });

  map.push(text.length);
  const joined = parts.join("");
  // Trust the arithmetic: a map that does not address the joined form exactly is
  // a wrong-offset bug waiting to surface as a misanchored mark.
  if (map.length !== joined.length + 1) throw new Error(`align map length ${map.length} != ${joined.length + 1}`);

  return {
    pageIndex: page.pageIndex,
    text,
    blocks: page.blocks,
    normalized: { normalized: joined, source: text, map: Int32Array.from(map) },
  };
};

/**
 * Build the index for a whole window: one normalization pass per page, not one
 * per mark. The dense-page case is many marks against one page, and rebuilding
 * per mark turns O(pages) into O(marks x pages).
 */
export const indexPages = (pages: readonly SemanticPageInput[]): IndexedPage[] => pages.map(indexPage);

export type MatchKind = "unique" | "prefix-suffix" | "hyphenated";

export type Aligned = {
  pageIndex: number;
  /** offsets into the ORIGINAL page text */
  start: number;
  end: number;
  /** the text actually matched, so a caller can show it verbatim */
  matchedText: string;
  kind: MatchKind;
  /** the block the match sits in; context is clamped to it */
  block: { start: number; end: number };
  /** sentence context inside the block, or null when no safe boundary exists */
  context: string | null;
};

export type AlignResult =
  | ({ status: "aligned" } & Aligned)
  | { status: "ambiguous" | "not-found"; reason: string; candidates: number };

export type AlignInput = {
  /** exact selected text, from PDF.js, unmodified */
  selection: string;
  /** zero-based page the selection came from */
  selectionPageIndex: number;
  /** quote prefix/suffix captured at selection time, if any */
  prefix?: string | undefined;
  suffix?: string | undefined;
  /** the pages worth searching: the visible window, nothing else */
  pages: readonly IndexedPage[];
};

const hasReplacement = (s: string): boolean => s.includes(REPLACEMENT_CHAR);

/** Every occurrence of `needle`, non-overlapping, forward, bounded. */
const findAll = (haystack: string, needle: string, cap = 512): number[] => {
  const hits: number[] = [];
  if (needle.length === 0) return hits;
  let from = 0;
  while (hits.length < cap) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    hits.push(at);
    from = at + 1;
  }
  return hits;
};

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * A match must land on word boundaries where the needle's own edge is a word
 * character. Without this, "the cat" matches inside "the catalog" — a false
 * positive with perfect confidence, which is what Section 17's "no more than 1%
 * wrong high-confidence contexts" budget exists to prevent.
 */
const onWordBoundary = (hay: string, at: number, len: number, needle: string): boolean => {
  if (isWordChar(needle[0]) && isWordChar(hay[at - 1])) return false;
  const tail = needle[needle.length - 1];
  if (isWordChar(tail) && isWordChar(hay[at + len])) return false;
  return true;
};

type Candidate = {
  page: IndexedPage;
  normStart: number;
  normEnd: number;
  block: { start: number; end: number };
};

/** Blocks are hard walls: the match start must fall inside one. */
const blockOf = (page: IndexedPage, offset: number): { start: number; end: number } | null => {
  for (const b of page.blocks) if (offset >= b.start && offset < b.end) return { start: b.start, end: b.end };
  return null;
};

const candidatesFor = (page: IndexedPage, needle: string): Candidate[] => {
  const out: Candidate[] = [];
  const hay = page.normalized.normalized;
  for (const at of findAll(hay, needle)) {
    if (!onWordBoundary(hay, at, needle.length, needle)) continue;
    const block = blockOf(page, toOriginalOffset(page.normalized, at));
    if (block === null) continue;
    out.push({ page, normStart: at, normEnd: at + needle.length, block });
  }
  return out;
};

/** True when text[i] ends a sentence: terminator, optional closer, then space. */
/** Shrink a range so it starts and ends on non-whitespace. */
const trimEdges = (text: string, range: { start: number; end: number }): { start: number; end: number } => {
  let { start, end } = range;
  while (start < end && /\s/.test(text[start] ?? "")) start++;
  while (end > start && /\s/.test(text[end - 1] ?? "")) end--;
  return { start, end };
};

const boundaryAt = (text: string, i: number): boolean => {
  const c = text[i];
  if (c !== "." && c !== "!" && c !== "?") return false;
  let j = i + 1;
  const closer = text[j];
  if (closer === '"' || closer === "'" || closer === ")" || closer === "]") j++;
  return /\s/.test(text[j] ?? "");
};

/**
 * Sentence bounds inside one block. ponytail: abbreviations ("Mr.") and
 * decimals split early — the named ceiling. Track B's selection work is where
 * Section 7 puts `Intl.Segmenter`; swap it in there, not here.
  * upgrade: if selection on a real book splits a sentence at "Mr." or a decimal, replace this with `Intl.Segmenter` rather than growing the abbreviation list.
 */
const sentenceAround = (text: string, block: { start: number; end: number }, from: number, to: number): string | null => {
  let open = block.start;
  for (let i = block.start; i < from; i++) if (boundaryAt(text, i)) open = i + 1;
  let close = block.end;
  for (let i = to; i < block.end; i++) {
    if (boundaryAt(text, i)) {
      close = i + 1;
      break;
    }
  }
  while (close > open && /\s/.test(text[close - 1] ?? "")) close--;
  if (close <= open) return null;
  const sentence = text.slice(open, close).trim();
  return sentence.length === 0 ? null : sentence;
};

/**
 * Line-end hyphenation, reversed only with evidence. A needle such as "scarlet-
 * red" (a wrapped line collapsed to a space) may also exist as "scarlet red" or
 * "scarletred"; the variant is used only when that exact form is in the page.
 * A needle ENDING in a hyphen is left alone: its continuation is unknown, and
 * inventing one is the guess Section 7 forbids.
 */
const hyphenationVariants = (needle: string, pageNormalized: string): string[] => {
  const out: string[] = [];
  for (let i = 1; i < needle.length - 1; i++) {
    if (needle[i] !== "-") continue;
    const after = needle.slice(i + 2);
    const head = needle.slice(0, i);
    for (const variant of [`${head} ${after}`, head + after]) {
      if (variant.length >= 4 && variant !== needle && pageNormalized.includes(variant)) out.push(variant);
    }
  }
  return out;
};

/**
 * The tested disambiguation rule. A candidate survives only if every stored
 * context side it has matches the page. A mismatch is a rejection, never a
 * fallback to "the closest one".
 */
const survivesContext = (c: Candidate, prefix?: string, suffix?: string): boolean => {
  const hay = c.page.normalized.normalized;
  if (prefix !== undefined) {
    // Compare in NORMALIZED space, and allow a separator between the stored
    // context and the match: "Finally he" is followed by a space in the page,
    // and the stored prefix has no trailing space because it was trimmed.
    const before = hay.slice(Math.max(0, c.normStart - prefix.length - 1), c.normStart).trimEnd();
    if (!before.toLowerCase().endsWith(prefix.toLowerCase())) return false;
  }
  if (suffix !== undefined) {
    const after = hay.slice(c.normEnd, c.normEnd + suffix.length + 1).trimStart();
    if (!after.toLowerCase().startsWith(suffix.toLowerCase())) return false;
  }
  return true;
};

const finalize = (c: Candidate, kind: MatchKind): Aligned => {
  const raw = toOriginalRange(c.page.normalized, c.normStart, c.normEnd);
  // The needle can begin on a collapsed space (the match starts at a word but
  // the space before it is part of the needle's leading run). Trim whitespace
  // only at the edges so the offsets point at the exact quoted characters.
  const range = trimEdges(c.page.text, raw);
  return {
    pageIndex: c.page.pageIndex,
    start: range.start,
    end: range.end,
    matchedText: c.page.text.slice(range.start, range.end),
    kind,
    block: c.block,
    context: sentenceAround(c.page.text, c.block, Math.max(range.start, c.block.start), Math.min(range.end, c.block.end)),
  };
};

/**
 * Section 7 steps 1-6. Pure. When it cannot prove a single location it says so
 * and the caller falls back to the exact selection plus verified PDF.js text.
 */
export function alignSelection(input: AlignInput): AlignResult {
  const raw = (input.selection ?? "").trim();
  if (raw.length === 0) return { status: "not-found", reason: "empty-selection", candidates: 0 };

  const sel = normalizeForMatch(raw);
  if (sel.normalized.length === 0)
    return { status: "not-found", reason: "selection-has-no-matchable-characters", candidates: 0 };

  // Step 3: relevant pages only, nearest to the selection's own page first.
  // Pages outside the caller's window are never searched. A cross-page selection
  // stays legal: reading order and parser order can disagree.
  const ordered = [...input.pages].sort((a, b) => {
    const da = Math.abs(a.pageIndex - input.selectionPageIndex);
    const db = Math.abs(b.pageIndex - input.selectionPageIndex);
    return da - db || a.pageIndex - b.pageIndex;
  });

  let all: Candidate[] = [];
  let hyphenated = false;
  for (const page of ordered) {
    const direct = candidatesFor(page, sel.normalized);
    if (direct.length > 0) {
      all = all.concat(direct);
      continue;
    }
    for (const variant of hyphenationVariants(sel.normalized, page.normalized.normalized)) {
      const hits = candidatesFor(page, variant);
      if (hits.length > 0) {
        all = all.concat(hits);
        hyphenated = true;
        break;
      }
    }
  }

  if (all.length === 0) return { status: "not-found", reason: "no-match-in-window", candidates: 0 };

  // Garbled page text cannot anchor a quote: the offsets would point at
  // replacement characters, so this is a not-found, not a low-confidence hit.
  const clean = all.filter((c) => !hasReplacement(c.page.text));
  if (clean.length === 0)
    return { status: "not-found", reason: "page-text-contains-replacement-characters", candidates: all.length };
  all = clean;

  const prefix = input.prefix?.trim() ? normalizeForMatch(input.prefix).normalized : undefined;
  const suffix = input.suffix?.trim() ? normalizeForMatch(input.suffix).normalized : undefined;

  // Step 5, unique case. One OCCURRENCE is what makes an anchor trustworthy;
  // three copies inside one paragraph is still ambiguous.
  if (all.length === 1) return { status: "aligned", ...finalize(all[0]!, hyphenated ? "hyphenated" : "unique") };

  // Step 4/5: a repeated phrase. Only stored context can break the tie.
  if (prefix !== undefined || suffix !== undefined) {
    const kept = all.filter((c) => survivesContext(c, prefix, suffix));
    if (kept.length === 0)
      return { status: "ambiguous", reason: "context-did-not-match-any-candidate", candidates: all.length };
    if (kept.length === 1) return { status: "aligned", ...finalize(kept[0]!, "prefix-suffix") };
    return { status: "ambiguous", reason: "context-matched-more-than-once", candidates: kept.length };
  }

  return { status: "ambiguous", reason: "repeated-selection-without-distinguishing-context", candidates: all.length };
}
