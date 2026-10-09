import { describe, expect, it } from "vitest";
import type { LearningExplanation } from "../../src/contracts/learning.ts";
import { explanationTextOf } from "../../src/features/vocabulary/capture.ts";

const legacy: LearningExplanation = {
  naturalTranslation: "memanfaatkan",
  provider: "fixture", model: "test-model", promptVersion: "v1",
};

describe("saved explanation text", () => {
  it("keeps legacy explanation formatting", () => {
    expect(explanationTextOf(legacy)).toBe("memanfaatkan");
    expect(explanationTextOf({ ...legacy, contextualMeaning: "menggunakan secara efektif", partOfSpeech: "verb", grammarNote: "Diikuti object.", simplerEnglish: "use well", example: { english: "Leverage your skills.", indonesian: "Manfaatkan kemampuanmu." } })).toBe(
      "memanfaatkan\n(verb)\nmenggunakan secara efektif\nGrammar: Diikuti object.\nSimpler: use well\ne.g. Leverage your skills. — Manfaatkan kemampuanmu.",
    );
  });

  it("retains sentence explanation and every alternative usage and example", () => {
    expect(explanationTextOf({
      ...legacy,
      naturalTranslation: "Mereka memanfaatkan data untuk mengambil keputusan.",
      sentenceExplanation: "Data menjadi dasar keputusan mereka.",
      contextualMeaning: "Menggunakan sesuatu agar mendapat keuntungan.",
      alternateMeanings: [
        { meaning: "Daya ungkit", usage: "Untuk gaya pada alat mekanik.", example: { english: "The lever provides leverage.", indonesian: "Tuas memberikan daya ungkit." } },
        { meaning: "Pengaruh", usage: "Untuk kekuatan dalam negosiasi.", example: { english: "They have leverage in the talks.", indonesian: "Mereka punya pengaruh dalam perundingan." } },
      ],
    })).toBe([
      "Mereka memanfaatkan data untuk mengambil keputusan.",
      "Sentence meaning: Data menjadi dasar keputusan mereka.",
      "Menggunakan sesuatu agar mendapat keuntungan.",
      "Other meaning: Daya ungkit", "Usage: Untuk gaya pada alat mekanik.", "e.g. The lever provides leverage. — Tuas memberikan daya ungkit.",
      "Other meaning: Pengaruh", "Usage: Untuk kekuatan dalam negosiasi.", "e.g. They have leverage in the talks. — Mereka punya pengaruh dalam perundingan.",
    ].join("\n"));
  });
});
