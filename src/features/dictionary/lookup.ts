/**
 * Dictionary lookup.
 *
 * Every path is an INDEXED query — `entries` on [packVersion+normalizedHeadword+senseId],
 * `aliases` on [alias+packVersion]. Nothing scans the dataset, and a miss performs
 * NO network request (IDEA.md section 9).
 *
 * The miss path is the one that matters: it returns `null`. It never invents a
 * lemma, a part of speech or a translation. `lookup()` returning null means "this
 * pack has no answer", which is a normal outcome, not an error.
 *
 * Track C.
 */

import type { DictionaryDB } from "./db.ts";
import { activePack } from "./db.ts";
import type { EntryRow } from "./pack.ts";
import { normalizeForm } from "./pack.ts";

export type LookupResult = {
  headword: string;
  normalizedForm: string;
  partOfSpeech: string | null;
  senses: { senseId: number; gloss: string; synonyms: string[] }[];
  /** how the surface form matched, for UI honesty — never a confidence score */
  matchedVia: "exact" | "normalized" | "alias" | "irregular" | "phrase" | "suffix-candidate";
};

export type LookupOptions = {
  db: DictionaryDB;
  surface: string;
  /** cap on suffix candidates returned; a miss must not return a whole table */
  maxCandidates?: number;
};

export type Lookup =
  | { found: true; result: LookupResult }
  | { found: false; reason: "no-active-pack" | "empty-surface" | "not-in-pack"; candidates: LookupResult[] };

const DEFAULT_MAX_CANDIDATES = 5;

/** Every sense of one headword, ordered by senseId. senseId 0 is the placeholder. */
const sensesOf = (rows: EntryRow[]): { senseId: number; gloss: string; synonyms: string[] }[] =>
  rows
    .filter((r) => r.senseId > 0)
    .sort((a, b) => a.senseId - b.senseId)
    // flatMap, not filter+map: the null check and the use must be one expression
    // or TS drops the narrowing.
    .flatMap((r) => (r.sense === null ? [] : [{ senseId: r.senseId, gloss: r.sense.gloss, synonyms: r.sense.synonyms }]));

const toResult = (rows: EntryRow[], matchedVia: LookupResult["matchedVia"]): LookupResult | null => {
  const head = rows[0];
  if (!head) return null;
  return {
    headword: head.headword,
    normalizedForm: head.normalizedHeadword,
    partOfSpeech: head.partOfSpeech,
    senses: sensesOf(rows),
    matchedVia,
  };
};

const rowsFor = (db: DictionaryDB, packVersion: string, normalized: string): Promise<EntryRow[]> =>
  db.entries.where("[packVersion+normalizedHeadword+senseId]").between(
    [packVersion, normalized, -Infinity],
    [packVersion, normalized, Infinity],
  ).toArray();

/**
 * Resolve one surface form.
 *
 * Order is deliberate and cheap-first:
 *   1. exact headword, 2. normalized form, 3. explicit alias, 4. known irregular
 *   form, 5. multi-word phrase, 6. conservative suffix candidates that ACTUALLY
 *   exist in this pack.
 *
 * Suffix candidates are a fallback only. They never fabricate a gloss: each
 * candidate is a real row fetched from the index.
 */
export const lookup = async (opts: LookupOptions): Promise<Lookup> => {
  const { db, surface } = opts;
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  const trimmed = surface.trim();
  if (!trimmed) return { found: false, reason: "empty-surface", candidates: [] };

  const active = await activePack(db);
  if (!active) return { found: false, reason: "no-active-pack", candidates: [] };
  const version = active.packVersion;

  // 1. exact headword as written, before any normalization
  const exact = await db.entries
    .where("[packVersion+normalizedHeadword+senseId]")
    .between([version, trimmed, -Infinity], [version, trimmed, Infinity])
    .toArray();
  const exactHit = toResult(exact, "exact");
  if (exactHit) return { found: true, result: exactHit };

  const normalized = normalizeForm(trimmed);

  // 2. normalized form (case, NFKC, apostrophe and whitespace variants)
  const normRows = await rowsFor(db, version, normalized);
  const normHit = toResult(normRows, "normalized");
  if (normHit) return { found: true, result: normHit };

  // 3./4. explicit alias or known irregular form -> its headword.
  // The alias table already merges both, so one indexed equals() covers them.
  const aliasRows = await db.aliases.where("[alias+packVersion]").equals([normalized, version]).toArray();

  for (const aliasRow of aliasRows) {
    const rows = await rowsFor(db, version, aliasRow.normalizedHeadword);
    const hit = toResult(rows, "alias");
    if (hit) return { found: true, result: hit };
  }

  // 5. phrase entry: try the whole surface, then leading words. Only real rows count.
  const words = normalized.split(" ").filter(Boolean);
  for (let n = words.length; n > 1; n--) {
    const phrase = words.slice(0, n).join(" ");
    const rows = await rowsFor(db, version, phrase);
    const hit = toResult(rows, "phrase");
    if (hit) return { found: true, result: hit };
  }

  // 6. conservative suffix candidates — real entries only, capped
  const candidates = await suffixCandidates(db, version, normalized, maxCandidates);
  return {
    found: false,
    reason: "not-in-pack",
    candidates,
  };
};

/**
 * Suffix fallback: for "running", try "run"->"runs"->"running" style variants by
 * stripping common inflections, then look each candidate up in the index.
 *
 * ponytail: fixed verb/noun suffix list, no Porter stemmer. A stemmer would be
 * wrong more often than right on learner lookups. Replace with a real morphology
 * table only if measured misses demand it.
 */
const SUFFIXES = ["ing", "ed", "es", "s", "er", "est", "ly", "ation", "ment", "ness"] as const;

const stemCandidates = (normalized: string): string[] => {
  const out = new Set<string>();
  for (const suffix of SUFFIXES) {
    if (!normalized.endsWith(suffix) || normalized.length - suffix.length < 3) continue;
    const stem = normalized.slice(0, -suffix.length);
    out.add(stem);
    // de-double the final consonant: running -> runn -> run
    if (/([^aeiou])\1$/.test(stem)) {
      out.add(stem.slice(0, -1));
      // and the -e restore: making -> mak -> make
      if (/[^aeiou]$/.test(stem)) out.add(`${stem}e`);
    }
    // restore a dropped silent e on an open syllable: mak -> make
    if (/[^aeiou]$/.test(stem)) out.add(`${stem}e`);
  }
  return [...out];
};

const suffixCandidates = async (
  db: DictionaryDB,
  version: string,
  normalized: string,
  limit: number,
): Promise<LookupResult[]> => {
  const seen = new Set<string>();
  const out: LookupResult[] = [];
  for (const candidate of stemCandidates(normalized)) {
    if (candidate.length < 3 || seen.has(candidate)) continue;
    seen.add(candidate);
    const rows = await rowsFor(db, version, candidate);
    const hit = toResult(rows, "suffix-candidate");
    if (hit) out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
};
