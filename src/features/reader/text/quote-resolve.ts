/**
 * Quote / anchor resolution for EPUB, TXT and Markdown (IDEA.md s7, s8,
 * Track E's marks contract).
 *
 * The contract is deliberately small: return a UNIQUE range or abstain.
 * Never guess. If a quote occurs twice and prefix/suffix cannot pick one,
 * the answer is `{resolved:false}` and the caller records `unresolved`.
 */

export type QuoteAnchor = {
  quote: string;
  prefix?: string;
  suffix?: string;
};

export type ResolvedRange = {
  resolved: true;
  start: number;
  end: number;
  /** How the match was found; diagnostics only. */
  via: "exact" | "normalized";
  /** Which occurrence survived disambiguation (0-based over all hits). */
  occurrence: number;
};

export type Abstained = { resolved: false; reason: AbstainReason };

export type AbstainReason =
  | "no-match"
  | "ambiguous"
  | "no-context"
  | "empty-quote"
  | "too-many-matches";

export type ResolutionResult = ResolvedRange | Abstained;

/** Bounds the work a single re-anchor may cost. Beyond this we abstain
 * rather than scan further — s7's watchdog principle, applied to matching. */
export const MAX_MATCHES = 1000;

function countOccurrences(haystack: string, needle: string, limit: number): { count: number; positions: number[] } {
  const positions: number[] = [];
  if (needle === "") return { count: 0, positions };
  let from = 0;
  while (positions.length < limit) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    positions.push(at);
    from = at + 1;
  }
  return { count: positions.length, positions };
}

/**
 * Map an index in `normalized` back to an index in the original text.
 * Normalization drops characters, so offsets are recovered by walking the
 * mapping table produced alongside the normalized form.
 */
export type NormalizedText = {
  normalized: string;
  /** originalIndex[i] = index in source of normalized[i]; -1 for injected. */
  originalIndex: Int32Array;
  /** length[i] = number of source characters consumed by normalized[i]. */
  length: Int32Array;
};

const APOSTROPHES = /['\u2018\u2019\u02bc\u2032]/g;
const QUOTES = /[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g;
const DASHES = /[\u2010-\u2015\u2212]/g;
const SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000\t]+/g;
const LIGATURES: Record<string, string> = { "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi", "\ufb04": "ffl", "\u017f": "s" };

/**
 * Normalization for matching ONLY (s7: normalize whitespace, ligatures and
 * apostrophe variants; retain original text and an offset mapping). Real
 * hyphens are preserved — line-end hyphenation is not reversed here because
 * there is no supporting evidence at this layer.
 */
export function normalizeForMatch(source: string): NormalizedText {
  const chars: string[] = [];
  const index: number[] = [];
  const length: number[] = [];
  let pendingSpace = false;

  const push = (ch: string, srcIndex: number, srcLength: number) => {
    chars.push(ch);
    index.push(srcIndex);
    length.push(srcLength);
  };

  for (let i = 0; i < source.length; ) {
    const ch = source[i] ?? "";
    const code = source.charCodeAt(i);

    if (code === 10 || code === 13 || code === 32 || SPACES.test(ch)) {
      SPACES.lastIndex = 0;
      if (SPACES.test(ch)) {
        pendingSpace = chars.length > 0;
        i++;
        continue;
      }
      pendingSpace = chars.length > 0;
      i++;
      continue;
    }

    if (pendingSpace) {
      push(" ", i, 0);
      pendingSpace = false;
    }

    const ligature = LIGATURES[ch];
    if (ligature !== undefined) {
      // One source char can expand to two normalized chars.
      const start = i;
      for (const c of ligature) push(c, start, 1);
      i++;
      continue;
    }

    APOSTROPHES.lastIndex = 0;
    QUOTES.lastIndex = 0;
    DASHES.lastIndex = 0;
    const normalizedCh = APOSTROPHES.test(ch)
      ? "'"
      : QUOTES.test(ch)
        ? '"'
        : DASHES.test(ch)
          ? "-"
          : ch;
    push(normalizedCh, i, 1);
    i++;
  }
  APOS_TAIL_CALL();
  return {
    normalized: chars.join(""),
    originalIndex: Int32Array.from(index),
    length: Int32Array.from(length),
  };
}

function APOS_TAIL_CALL(): void {
  APOSTROPHES.lastIndex = 0;
  DASHES.lastIndex = 0;
  SPACES.lastIndex = 0;
}

/** Map a normalized span [from, to) onto source offsets, honouring length 0
 * (injected spaces) which belong to no source character. */
function toSourceRange(n: NormalizedText, from: number, to: number): { start: number; end: number } | null {
  if (from < 0 || to <= from || to > n.normalized.length) return null;
  let start = -1;
  for (let i = from; i < to; i++) {
    const at = n.originalIndex[i] ?? -1;
    const len = n.length[i] ?? 0;
    if (at < 0 || len === 0) continue;
    if (start < 0) start = at;
  }
  if (start < 0) return null;
  let end = start;
  for (let i = from; i < to; i++) {
    const at = n.originalIndex[i] ?? -1;
    const len = n.length[i] ?? 0;
    if (at < 0 || len === 0) continue;
    end = Math.max(end, at + len);
  }
  return { start, end };
}

/** Does the text around `at` agree with the stored context? */
function contextMatches(source: string, quoteStart: number, quote: string, anchor: QuoteAnchor): boolean {
  if (anchor.prefix !== undefined && anchor.prefix !== "") {
    const want = anchor.prefix.slice(-Math.min(anchor.prefix.length, 64));
    const got = source.slice(Math.max(0, quoteStart - want.length), quoteStart);
    if (got !== want) return false;
  }
  if (anchor.suffix !== undefined && anchor.suffix !== "") {
    const want = anchor.suffix.slice(0, Math.min(anchor.suffix.length, 64));
    const end = quoteStart + quote.length;
    if (source.slice(end, end + want.length) !== want) return false;
  }
  return true;
}

type Candidate = { start: number; end: number; occurrence: number; via: "exact" | "normalized" };

/**
 * Resolve a stored quote against current document text.
 *
 * Order: exact substring match, then normalized matching for typography
 * changes. Ambiguity at any stage is an abstention, never a pick.
 */
export function resolveQuote(source: string, anchor: QuoteAnchor): ResolutionResult {
  const quote = anchor.quote ?? "";
  if (quote === "") return { resolved: false, reason: "empty-quote" };

  const exact = collectExact(source, quote, anchor);
  if (exact.candidates.length === 1) return resolved(exact.candidates[0]!, "exact");
  if (exact.candidates.length > 1) return { resolved: false, reason: "ambiguous" };
  if (exact.hitLimit) return { resolved: false, reason: "too-many-matches" };
  // The quote occurs in the document, but no occurrence matched the stored
  // context. Reporting `no-match` here would be a lie that hides an
  // unresolvable anchor, so it stays ambiguous (s7: label, do not guess).
  if (exact.occurrences > 1) return { resolved: false, reason: "ambiguous" };

  const normalized = normalizeForMatch(source);
  const wantQuote = normalizeForMatch(quote).normalized;
  if (wantQuote === "") return { resolved: false, reason: "no-match" };
  const wantPrefix = anchor.prefix === undefined ? undefined : normalizeForMatch(anchor.prefix).normalized;
  const wantSuffix = anchor.suffix === undefined ? undefined : normalizeForMatch(anchor.suffix).normalized;

  const hits = countOccurrences(normalized.normalized, wantQuote, MAX_MATCHES);
  if (hits.count === 0) return { resolved: false, reason: "no-match" };

  const candidates: Candidate[] = [];
  for (let k = 0; k < hits.positions.length; k++) {
    const at = hits.positions[k];
    if (at === undefined) continue;
    const mapped = toSourceRange(normalized, at, at + wantQuote.length);
    if (mapped === null) continue;
    const match = { start: mapped.start, end: mapped.end };
    if (!contextMatches(source, match.start, source.slice(match.start, match.end), {
      quote,
      ...(wantPrefix === undefined ? {} : { prefix: wantPrefix }),
      ...(wantSuffix === undefined ? {} : { suffix: wantSuffix }),
    })) {
      continue;
    }
    candidates.push({ start: match.start, end: match.end, occurrence: k, via: "normalized" });
  }

  if (candidates.length === 0) return { resolved: false, reason: "no-match" };
  if (candidates.length > 1) {
    // Prefix/suffix agreed with more than one hit: still ambiguous.
    return { resolved: false, reason: "ambiguous" };
  }
  const only = candidates[0]!;
  return resolved(only, "normalized");
}

function resolved(candidate: Candidate, via: "exact" | "normalized"): ResolvedRange {
  return { resolved: true, start: candidate.start, end: candidate.end, via, occurrence: candidate.occurrence };
}

function collectExact(
  source: string,
  quote: string,
  anchor: QuoteAnchor,
): { candidates: Candidate[]; occurrences: number; hitLimit: boolean } {
  const hits = countOccurrences(source, quote, MAX_MATCHES);
  const candidates: Candidate[] = [];
  for (let k = 0; k < hits.positions.length; k++) {
    const at = hits.positions[k];
    if (at === undefined) continue;
    if (!contextMatches(source, at, quote, anchor)) continue;
    candidates.push({ start: at, end: at + quote.length, occurrence: k, via: "exact" });
  }
  return { candidates, occurrences: hits.count, hitLimit: hits.positions.length === MAX_MATCHES };
}

/**
 * Track E entry point: resolve an Anchor's quote inside one unit of text and
 * report the resulting anchor state. `unresolved` is the honest outcome when
 * the text cannot be located unambiguously; `lost` is the caller's decision
 * after a document-level sweep also fails.
 */
export function resolveAnchorIn(source: string, anchor: QuoteAnchor): { state: "resolved"; range: ResolvedRange } | { state: "unresolved"; reason: AbstainReason } {
  const result = resolveQuote(source, anchor);
  if (result.resolved) return { state: "resolved", range: result };
  return { state: "unresolved", reason: result.reason };
}
