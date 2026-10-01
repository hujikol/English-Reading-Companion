/**
 * Anchor capture from a live selection. Section 7 step 2: normalize whitespace,
 * ligatures and apostrophe variants FOR MATCHING only, while retaining the
 * original text and an offset mapping back into it. Nothing here is persisted
 * geometry — `pageFraction` is a scroll position within the page.
 */

import type { Anchor, Locator } from "../../contracts/index.ts";

export const CONTEXT_CHARS = 60;

export type Normalized = {
  /** normalized form; the only text that is ever searched */
  text: string;
  /** for each index of `text`, the index into the original string it came from */
  offsets: number[];
  /** original length + 1, so the end offset of a match maps too */
  originalLength: number;
};

const LIGATURES: Record<string, string> = {
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
  "ﬅ": "ft",
  "ﬆ": "st",
};

/** Every apostrophe-like and quote-like code point a PDF text layer emits. */
const APOSTROPHES = "'‘’ʼ´`";
const DASHES = new Set(["‐", "‑", "‒", "–", "—", "―"]);
/** JS /\s covers ASCII whitespace plus U+00A0, U+2028/9, U+FEFF and U+3000. */
const SPACE_RE = /\s/;

/**
 * Lowercase, collapse runs of whitespace to one space, expand ligatures, fold
 * apostrophe and quote variants, normalize dashes, and drop soft hyphens.
 *
 * Real hyphens inside words are preserved: line-end hyphenation is only reversed
 * with supporting evidence (Section 7), so this must not guess.
 */
export function normalize(text: string): Normalized {
  let out = "";
  const offsets: number[] = [];
  let pendingSpace = false;
  let emittedAny = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;

    if (SPACE_RE.test(ch)) {
      if (emittedAny) pendingSpace = true;
      continue;
    }
    if (ch === "­") continue; // soft hyphen: invisible, never matched
    if (ch === "﻿") continue; // BOM anywhere in a page

    const expansion = LIGATURES[ch];
    if (expansion !== undefined) {
      for (const c of expansion.toLowerCase()) {
        if (pendingSpace && emittedAny) {
          out += " ";
          offsets.push(i);
          pendingSpace = false;
        }
        out += c;
        offsets.push(i);
      }
      emittedAny = true;
      continue;
    }

    let c: string;
    if (APOSTROPHES.includes(ch)) c = "'";
    else if (DASHES.has(ch)) c = "-";
    else c = ch.toLowerCase();

    if (pendingSpace && emittedAny) {
      out += " ";
      offsets.push(i);
      pendingSpace = false;
    }
    for (const lowered of c) {
      out += lowered;
      offsets.push(i);
    }
    emittedAny = true;
  }

  offsets.push(text.length);
  return { text: out, offsets, originalLength: text.length };
}

export type Match = {
  /** index into the normalized page text */
  start: number;
  /** exclusive */
  end: number;
  /** index into the original page text */
  originalStart: number;
  originalEnd: number;
};

/**
 * Every occurrence of `needle` in `haystack` (already normalized), mapped back
 * to original offsets. A repeated phrase returns several matches; the caller
 * disambiguates with prefix/suffix instead of guessing.
 *
 * ponytail: a normalized space can be emitted lazily, before the character that
 * follows it, so `offsets[end]` may point at the source character one position
 * late. `trimEnd` on the recovered original slice is what makes the mapping
 * usable; a full char-by-char re-scan buys nothing until a fixture proves it.
 */
export function findMatches(haystack: Normalized, needle: Normalized): Match[] {
  const out: Match[] = [];
  if (needle.text === "") return out;
  let from = 0;
  for (;;) {
    const at = haystack.text.indexOf(needle.text, from);
    if (at < 0) break;
    const end = at + needle.text.length;
    const rawStart = haystack.offsets[at] ?? 0;
    const rawEnd = haystack.offsets[end] ?? haystack.originalLength;
    // a lazily emitted space can park a source offset one character late
    out.push({ start: at, end, originalStart: rawStart, originalEnd: Math.min(rawEnd, haystack.originalLength) });
    from = at + 1;
  }
  return out;
}

/** Recover the exact original substring a match covers, whitespace run included. */
export function originalSlice(pageText: string, m: Match): string {
  return pageText.slice(m.originalStart, m.originalEnd).trimEnd();
}

/**
 * Section 7 step 4: with several matches, keep the one whose surrounding text
 * agrees with the anchor's prefix and suffix. No candidates left means ambiguous,
 * which is reported rather than resolved.
 */
export function disambiguate(pageText: string, quote: string, prefix?: string, suffix?: string): Match | undefined {
  const page = normalize(pageText);
  const q = normalize(quote);
  const matches = findMatches(page, q);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];

  const wantPre = prefix === undefined ? undefined : normalize(prefix).text;
  const wantSuf = suffix === undefined ? undefined : normalize(suffix).text;
  const scored = matches.filter((m) => {
    const before = page.text.slice(Math.max(0, m.start - CONTEXT_CHARS), m.start);
    const after = page.text.slice(m.end, m.end + CONTEXT_CHARS);
    // stored context includes its surrounding space; trim so "beta" and "beta " both match
    return (wantPre === undefined || before.trimEnd().endsWith(wantPre)) && (wantSuf === undefined || after.trimStart().startsWith(wantSuf));
  });
  return scored.length === 1 ? scored[0] : undefined;
}

/** ~CONTEXT_CHARS of original text on each side of a match, for the stored anchor. */
export const contextAround = (pageText: string, start: number, end: number): { prefix: string; suffix: string } => ({
  prefix: pageText.slice(Math.max(0, start - CONTEXT_CHARS), start),
  suffix: pageText.slice(end, end + CONTEXT_CHARS),
});

/** Where a selection sits in its page, as a 0..1 scroll fraction. */
export const pageFractionOf = (top: number, pageHeight: number): number => {
  if (!Number.isFinite(top) || !Number.isFinite(pageHeight) || pageHeight <= 0) return 0;
  const f = top / pageHeight;
  return f < 0 ? 0 : f > 1 ? 1 : Math.round(f * 1e6) / 1e6;
};

/** Normalize a value that came from the DOM or a restored record. */
export const cleanPageFraction = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : Math.round(v * 1e6) / 1e6) : 0;

/**
 * Build the durable anchor. `quote` keeps the ORIGINAL selected text; only the
 * matching view is normalized.
 */
export function captureAnchor(input: {
  selectedText: string;
  pageIndex: number;
  pageFraction: number;
  /** original page text, used for prefix/suffix */
  pageText?: string;
  /** offsets of selectedText inside pageText; computed when omitted */
  startInPage?: number;
  now?: number;
}): Anchor {
  const quote = input.selectedText;
  const trimmedStart = input.startInPage;
  const locatorBase = { kind: "pdf" as const, pageIndex: input.pageIndex, pageFraction: cleanPageFraction(input.pageFraction) };

  if (input.pageText === undefined)
    return { quote, locator: locatorBase, anchorState: "unresolved" };

  const start = trimmedStart ?? input.pageText.indexOf(quote);
  if (start < 0) return { quote, locator: locatorBase, anchorState: "unresolved" };

  const { prefix, suffix } = contextAround(input.pageText, start, start + quote.length);
  return {
    quote,
    prefix,
    suffix,
    locator: locatorBase,
    anchorState: "resolved",
    ...(input.now === undefined ? {} : { resolvedAt: input.now }),
  };
}

export type ReanchorResult =
  | { anchorState: "resolved"; locator: Locator; resolvedAt: number }
  | { anchorState: "unresolved" | "lost"; locator: Locator };

/**
 * Re-find a stored anchor in current page text. The locator's page and fraction
 * are always preserved: a failed match reports unresolved/lost, it never moves
 * the position and never draws a guess.
 */
export function reanchor(anchor: Anchor, pageText: string, now: number = Date.now()): ReanchorResult {
  const locator = anchor.locator;
  if (locator.kind !== "pdf") return { anchorState: "unresolved", locator };
  const m = disambiguate(pageText, anchor.quote, anchor.prefix, anchor.suffix);
  if (m === undefined) return { anchorState: "unresolved", locator };
  const pageFraction = cleanPageFraction(m.originalStart / Math.max(1, pageText.length));
  return { anchorState: "resolved", locator: { ...locator, pageFraction }, resolvedAt: now };
}

/** A quote that no longer occurs anywhere in the document is lost, not merely unresolved. */
export const isLost = (quote: string, allPageText: readonly string[]): boolean => !allPageText.some((t) => normalize(t).text.includes(normalize(quote).text));
