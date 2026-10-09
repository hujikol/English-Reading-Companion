import { describe, expect, it } from "vitest";
import { indonesianFor } from "../../scripts/dictionary/kaikki-to-dsl.ts";

const entry = (word: string, pos: string, translations: string[], tags?: string[]) => ({
  word,
  pos,
  senses: [
    {
      glosses: ["a gloss"],
      ...(tags === undefined ? {} : { tags }),
      translations: translations.map((t) => ({ lang_code: "id", word: t })),
    },
  ],
});

describe("indonesianFor: keeps real vocabulary", () => {
  it("keeps an ordinary verb", () => {
    expect(indonesianFor(entry("run", "verb", ["berlari"]))).toEqual(["berlari"]);
  });

  it("keeps an ordinary adjective", () => {
    expect(indonesianFor(entry("happy", "adj", ["bahagia"]))).toEqual(["bahagia"]);
  });

  it("keeps several translations for one sense", () => {
    expect(indonesianFor(entry("book", "noun", ["buku", "kitab"]))).toEqual(["buku", "kitab"]);
  });

  it("deduplicates repeated translations", () => {
    expect(indonesianFor(entry("book", "noun", ["buku", "buku"]))).toEqual(["buku"]);
  });

  it("keeps a multi-word phrase", () => {
    expect(indonesianFor(entry("lay down", "verb", ["membaringkan"]))).toEqual(["membaringkan"]);
  });

  it("keeps a hyphenated compound", () => {
    expect(indonesianFor(entry("well-known", "adj", ["terkenal"]))).toEqual(["terkenal"]);
  });

  it("keeps a capitalised proper adjective that is real vocabulary", () => {
    // English is capitalised but is a common word in Indonesian-language books.
    expect(indonesianFor(entry("English", "adj", ["Inggris"]))).toEqual(["Inggris"]);
  });
});

describe("indonesianFor: drops what a learner does not want", () => {
  it("drops proper nouns", () => {
    expect(indonesianFor(entry("Paris", "name", ["Paris"]))).toEqual([]);
  });

  it("drops weekdays and months", () => {
    expect(indonesianFor(entry("Monday", "noun", ["Senin"]))).toEqual([]);
    expect(indonesianFor(entry("January", "noun", ["Januari"]))).toEqual([]);
  });

  it("drops the English articles and one-letter fragments", () => {
    expect(indonesianFor(entry("the", "noun", ["itu"]))).toEqual([]);
    expect(indonesianFor(entry("of", "noun", ["dari"]))).toEqual([]);
  });

  it("keeps a sense tagged only with grammar labels", () => {
    // Regression: transitive/intransitive/countable describe how a word works,
    // not whether it is usable. Filtering on them removed most verbs and nouns
    // — "run" and "water" each lost every sense to them.
    expect(indonesianFor(entry("run", "verb", ["berlari"], ["intransitive"]))).toEqual(["berlari"]);
    expect(indonesianFor(entry("run", "verb", ["menjalankan"], ["transitive"]))).toEqual(["menjalankan"]);
    expect(indonesianFor(entry("water", "noun", ["air"], ["uncountable", "countable"]))).toEqual(["air"]);
    expect(indonesianFor(entry("see", "verb", ["melihat"], ["transitive", "intransitive"]))).toEqual(["melihat"]);
  });

  it("drops an obscure or non-standard sense", () => {
    expect(indonesianFor(entry("quire", "noun", ["x"], ["rare"]))).toEqual([]);
    expect(indonesianFor(entry("golly", "noun", ["x"], ["obsolete", "dialectal"]))).toEqual([]);
  });

  it("drops a non-Latin-script headword", () => {
    expect(indonesianFor(entry("日本語", "noun", ["Jepang"]))).toEqual([]);
  });

  it("drops a sense with no English gloss", () => {
    expect(indonesianFor({ word: "run", pos: "verb", senses: [{ glosses: [], translations: [{ lang_code: "id", word: "x" }] }] })).toEqual([]);
  });

  it("ignores translations that are not Indonesian", () => {
    expect(
      indonesianFor({
        word: "run",
        pos: "verb",
        senses: [{ glosses: ["g"], translations: [{ lang_code: "de", word: "laufen" }] }],
      }),
    ).toEqual([]);
  });

  it("rejects a gloss that is a sentence, not a meaning", () => {
    const long = "this is a very long piece of text that is clearly a sentence rather than a translation";
    expect(indonesianFor(entry("run", "verb", [long]))).toEqual([]);
  });
});

it("keeps entry-level Indonesian translations emitted by Wiktextract", () => {
  expect(indonesianFor({ word: "water", pos: "noun", senses: [{ glosses: ["A liquid"], tags: ["uncountable"] }], translations: [{ lang_code: "id", word: "air" }] })).toContain("air");
});
