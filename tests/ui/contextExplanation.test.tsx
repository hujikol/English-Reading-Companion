import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LearningExplanation } from "../../src/contracts/learning.ts";
import { ContextExplanation } from "../../src/ui/ContextExplanation.tsx";

const legacy: LearningExplanation = { naturalTranslation: "memanfaatkan", provider: "fixture", model: "test-model", promptVersion: "v1" };

describe("context explanation display", () => {
  it("renders old results without inventing missing explanation sections", () => {
    const html = renderToStaticMarkup(<ContextExplanation result={legacy} />);
    expect(html).toContain("Natural Indonesian sentence");
    expect(html).toContain("memanfaatkan");
    expect(html).toContain("fixture / test-model");
    for (const section of ["Sentence meaning", "This word here", "Other meanings", "Use this meaning"]) expect(html).not.toContain(section);
  });

  it("shows sentence context, alternative usages and examples as plain text", () => {
    const html = renderToStaticMarkup(<ContextExplanation result={{
      ...legacy, sentenceExplanation: "<script>alert(1)</script>", contextualMeaning: "menggunakan secara efektif",
      partOfSpeech: "verb", grammarNote: "Diikuti object.", simplerEnglish: "use well",
      alternateMeanings: [{ meaning: "daya ungkit", usage: "alat mekanik", example: { english: "A longer lever.", indonesian: "Tuas yang lebih panjang." } }],
      example: { english: "Leverage your skills.", indonesian: "Manfaatkan kemampuanmu." },
    }} onUseMeaning={() => {}} />);
    for (const text of ["Sentence meaning", "This word here", "Other meanings", "daya ungkit", "alat mekanik", "A longer lever.", "Tuas yang lebih panjang.", "Usage / grammar", "Simpler English", "Another example", "Use this meaning"]) expect(html).toContain(text);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
