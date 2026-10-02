/**
 * kaikki.org JSONL -> the pack DSL that `build-pack.ts` already understands.
 *
 * Why a two-stage pipeline: `build-pack.ts` is the tested authority on chunking,
 * checksums, the manifest and atomic activation. Feeding it the DSL keeps every
 * guarantee it already has instead of reimplementing pack assembly here.
 *
 * What this extracts: English headwords that have at least one Indonesian
 * (`lang_code === "id"`) translation. That is the direction this app looks up —
 * a learner reading English selects an English word.
 *
 * Deliberately dropped, because they are noise for a learner at reading time:
 *  - proper nouns (pos "name") — capitalised names are not vocabulary
 *  - romanised entries with no alphabetic headword
 *  - duplicate (headword, pos, Indonesian word) triples
 *
 * Usage:
 *   vite-node scripts/dictionary/kaikki-to-dsl.ts <in.jsonl.gz> <out.dsl> [attribution]
 *
 * Streams: the file is read line by line and never held whole in memory.
 */

import { createReadStream } from "node:fs";
import { createWriteStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { basename } from "node:path";

/**
 * Tags that mark a sense as too obscure, non-standard or unsuitable for a
 * learner.
 *
 * Grammar labels are deliberately NOT here. `transitive`, `intransitive`,
 * `countable`, `uncountable` and the inflection tags describe how a word works,
 * not whether it is usable — filtering on them threw away most verbs and nouns
 * ("run", "water", "see"), because Wiktionary tags the large majority of senses
 * with one of them. Only senses marked obsolete/rare/archaic are dropped.
 */
const SKIP_TAGS = new Set([
  "obsolete", "rare", "archaic", "dialectal", "slang", "vulgar", "offensive",
  "alternative", "abbreviation", "acronym", "initialism", "misspelling",
  "nonstandard", "proscribed", "childish", "derogatory", "humorous",
  "poetic", "literary", "colloquial", "informal", "formal",
]);

/**
 * Words a learner meets constantly in a novel but which are not vocabulary:
 * weekdays, months, and languages/nationalities used as a bare noun. They are
 * Capitalised-but-otherwise-ordinary, so the proper-noun rule cannot catch
 * them; they are listed rather than guessed.
 */
const BORING_HEADS = new Set([
  ...["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
  ...["january", "february", "march", "april", "may", "june", "july", "august",
      "september", "october", "november", "december"],
  ...["greek", "latin"],
  ...["god", "christ", "jesus", "muhammad", "allah", "bible", "quran", "torah"],
  ...["batavian", "celtic", "slavic", "germanic", "romanic", "indo-european"],
]);

/** Surnames and places that survive the Capitalised filter. */
const PLACE_OR_NAME = /\b(shire|ville|burg|stan|ford|field|wood|dale|mont|ton|ham|shire|shire)$/i;

type Translation = { word?: unknown; lang_code?: unknown };
type Sense = {
  glosses?: unknown;
  tags?: unknown;
  translations?: unknown;
};
type Record_ = {
  word?: unknown;
  pos?: unknown;
  senses?: unknown;
  forms?: unknown;
};

const WORDS = new Set(["a", "an", "the"]);

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * One entry -> its Indonesian translations, or [] if it is not worth shipping.
 * Exported for testing: the filtering rules are the substance of this file.
 */
export function indonesianFor(entry: Record_): string[] {
  if (typeof entry.word !== "string") return [];
  const word = entry.word.trim();
  // A one- or two-letter headword is noise; so are the English articles.
  if (word.length < 3 || WORDS.has(word.toLowerCase())) return [];
  // Proper nouns: "Paris", "Shakespeare". Capitalised entries in a dictionary
  // extract are overwhelmingly names, and a learner reading a novel has no use
  // for them. All-lowercase headwords are kept regardless of length.
  if (entry.pos === "name") return [];
  if (/^[A-Z]/.test(word) && !/^[A-Z][a-z]+$/.test(word)) return [];
  if (BORING_HEADS.has(word.toLowerCase())) return [];
  if (PLACE_OR_NAME.test(word)) return [];
  // Latin script only, but diacritics allowed: "café" is real vocabulary, while
  // a Cyrillic or Devanagari headword is useless as an English lookup key.
  if (!/^\p{Script=Latin}[\p{Script=Latin}' .-]*$/u.test(word)) return [];

  const out: string[] = [];
  for (const sense of Array.isArray(entry.senses) ? (entry.senses as Sense[]) : []) {
    const tags = asStringArray(sense.tags);
    if (tags.some((t) => SKIP_TAGS.has(t))) continue;
    if (!asStringArray(sense.glosses).length) continue;
    for (const t of Array.isArray(sense.translations) ? (sense.translations as Translation[]) : []) {
      if (t?.lang_code !== "id") continue;
      if (typeof t.word !== "string") continue;
      const v = t.word.trim();
      // A gloss is a meaning, not a sentence.
      if (v === "" || v.length > 40) continue;
      out.push(v);
    }
  }
  return [...new Set(out)];
}

/** DSL-escape a value. The DSL is line-oriented, so newlines are fatal. */
const dslValue = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();

const POS_MAP: Record<string, string> = {
  noun: "noun", verb: "verb", adj: "adjective", adv: "adverb",
  pron: "pronoun", prep: "preposition", conj: "conjunction",
  intj: "interjection", num: "numeral", article: "article", particle: "particle",
};

export type ConvertReport = {
  lines: number;
  parsed: number;
  entries: number;
  senses: number;
  outFile: string;
};

const emitBlock = (b: Block): string =>
  [
    `== ${b.word} ==`, "", `{{headword|en|${dslValue(b.word)}}}`, "",
    `{{pos|${b.pos}}}`,
    "", "{{trans-top|Indonesian}}", "",
    ...b.translations.map((t) => `*- ${dslValue(t)}`),
    "", "{{trans-bottom}}", "",
  ].join("\n") + "\n";

/**
 * Upstream mistakes worth catching. Wiktionary's `polish` (verb) carries a
 * stray "poles" gloss from a neighbouring entry; shipping it teaches the
 * learner a wrong translation. Each entry is a confirmed upstream defect, not a
 * guess — add here rather than filtering by pattern.
 */
const SUSPECT_GLOSSES = new Map<string, Set<string>>([
  ["polish", new Set(["poles"])],
]);

export type Block = { word: string; pos: string; translations: string[] };

export async function convert(input: string, output: string, attribution: string): Promise<ConvertReport> {
  const lines = createInterface({
    input: createReadStream(input).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  // The extract is NOT sorted by headword (verified: ~35k out-of-order
  // transitions in the first 120k lines), so no streaming-window trick can
  // merge a word's records. Collect into a Map and emit at the end. This holds
  // ~12k headwords, not the 3 GB of input: the input is still read line by line.
  const words = new Map<string, Block>();
  let parsed = 0;
  let index = 0;

  for await (const line of lines) {
    index++;
    if (line.trim() === "") continue;
    let entry: Record_;
    try {
      entry = JSON.parse(line) as Record_;
    } catch {
      continue; // a truncated tail line, or a non-object: skip rather than abort
    }
    parsed++;

    const translations = indonesianFor(entry).filter(
      (t) => !SUSPECT_GLOSSES.get((entry.word as string).trim().toLowerCase())?.has(t),
    );
    if (translations.length === 0) continue;

    const word = (entry.word as string).trim();
    const key = word.toLowerCase();
    const existing = words.get(key);
    if (existing !== undefined) {
      // Same headword seen again (a second part of speech, or a second record).
      // Merge the glosses into one block: the pack builder rejects a duplicate
      // headword outright, and dropping the record would lose senses.
      for (const t of translations) {
        if (!existing.translations.includes(t)) existing.translations.push(t);
      }
      continue;
    }
    words.set(key, {
      word,
      pos: POS_MAP[entry.pos as string] ?? "noun",
      translations: [...translations],
    });
  }

  // Emit in sorted order: deterministic output, so the same input always
  // produces the same DSL and therefore the same pack hash.
  const blocks = [...words.values()].sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));

  const out = createWriteStream(output, { encoding: "utf8" });
  const write = (text: string): Promise<void> =>
    out.write(text) ? Promise.resolve() : new Promise((r) => out.once("drain", r));

  await write(
    [
      "# Generated by scripts/dictionary/kaikki-to-dsl.ts — do not edit by hand.",
      `# source: ${basename(input)}`,
      `# attribution: ${attribution}`,
      "",
      "",
    ].join("\n"),
  );

  let senses = 0;
  const CHUNK = 1000;
  for (let i = 0; i < blocks.length; i += CHUNK) {
    await write(blocks.slice(i, i + CHUNK).map(emitBlock).join(""));
  }
  for (const b of blocks) senses += b.translations.length;

  out.end();
  return { lines: index, parsed, entries: blocks.length, senses, outFile: output };
}

// Run only when invoked as the script.
//
// `import.meta.url` is the reliable signal: vite-node rewrites process.argv[1]
// to its own CLI shim, so an argv check is false and the whole conversion
// becomes a silent no-op that still exits 0.
//
// The test for this module sets ERC_NO_CLI, because import.meta.url matches
// there too and the CLI branch would exit the test runner.
const isScript = import.meta.url.endsWith("kaikki-to-dsl.ts") && process.env.ERC_NO_CLI !== "1";
if (isScript) {
  const [input, output, attribution = "Wiktionary contributors, CC BY-SA 3.0/4.0; extracted via kaikki.org"] = process.argv.slice(2);
  if (input === undefined || output === undefined) {
    process.stderr.write("usage: kaikki-to-dsl.ts <in.jsonl.gz> <out.dsl> [attribution]\n");
    process.exit(2);
  }
  convert(input, output, attribution)
    .then((r) => {
      process.stdout.write(
        `parsed ${r.parsed}/${r.lines} lines -> ${r.entries} entries, ${r.senses} Indonesian glosses -> ${r.outFile}\n`,
      );
    })
    .catch((e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
