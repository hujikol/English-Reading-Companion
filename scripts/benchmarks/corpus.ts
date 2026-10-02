/**
 * Corpus generation for the inspector benchmark.
 *
 * SYNTHETIC, GENERATED, AND DELIBERATELY SO. The Section 17 corpus calls for
 * ~30 redistributable test documents, and no such corpus exists in this repo
 * yet. Rather than reach for documents that are not ours to read, this
 * generates PDFs from a deterministic word list. That is strictly better for a
 * throughput benchmark than a borrowed real book:
 *
 *   - the expected per-page text is known exactly, so the benchmark asserts
 *     CORRECTNESS (page count, per-page text non-empty, correct order) and not
 *     merely that a number came out;
 *   - the corpus is reproducible from this file, so a future run is comparable
 *     to this one without shipping binaries;
 *   - page text length is controlled, so pages-per-second is a real measurement
 *     rather than a property of whatever file was handy.
 *
 * It does NOT replace the Section 17 corpus. Real books carry embedded font
 * programs, multi-column layouts, tables, broken encodings and ligatures, and
 * those parse far slower than this fixture does. Numbers here are a FLOOR, not
 * a representative figure, and the report says so.
 */

import { buildPdf } from "../../tests/semantic/integration/pdfFixture.ts";
import type { PageSpec } from "../../tests/semantic/integration/pdfFixture.ts";

/** Deterministic PRNG so two runs build byte-identical documents. */
const makeRng = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const WORDS = (
  "reading vocabulary sentence context paragraph attention habit patience reader " +
  "selection marker occurrence definition translation evidence boundary prefix suffix " +
  "chapter edition volume appendix glossary index review capture archive restore"
).split(" ");

const SENTENCE_WORDS = 14;

/** One page of pseudo-prose, deterministic for a given (seed, page). */
const makePage = (seed: number, page: number, paragraphs: number): PageSpec => {
  const rng = makeRng(seed * 7919 + page);
  const out: PageSpec = [];
  for (let p = 0; p < paragraphs; p++) {
    const sentences: string[] = [];
    const sentenceCount = 4;
    for (let s = 0; s < sentenceCount; s++) {
      const words: string[] = [];
      for (let w = 0; w < SENTENCE_WORDS; w++) {
        words.push(WORDS[Math.floor(rng() * WORDS.length)]!);
      }
      const text = words.join(" ");
      sentences.push(`${text.charAt(0).toUpperCase()}${text.slice(1)}.`);
    }
    out.push(sentences.join(" "));
  }
  return out;
};

// Local alias so the annotation above reads clearly; `PageSpec` is string[].
type stringSpec = string[];

export type CorpusSpec = {
  name: string;
  pages: number;
  /** paragraphs per page, which sets page text length */
  paragraphs: number;
};

/** The documents the benchmark measures. Small enough to run anywhere. */
export const CORPUS: readonly CorpusSpec[] = [
  { name: "tiny-3p", pages: 3, paragraphs: 2 },
  { name: "bookish-50p", pages: 50, paragraphs: 4 },
  { name: "long-120p", pages: 120, paragraphs: 4 },
];

/** Build one corpus document as real PDF bytes. */
export const buildCorpusPdf = (spec: CorpusSpec): Uint8Array => {
  const pages: PageSpec[] = [];
  for (let i = 0; i < spec.pages; i++) pages.push(makePage(spec.pages, i, spec.paragraphs));
  return buildPdf(pages, { title: `erc-bench-${spec.name}` });
};
