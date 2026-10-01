import { describe, expect, it } from "vitest";
import {
  alignSelection,
  indexPages,
  normalizeForMatch,
  toOriginalOffset,
  toOriginalRange,
} from "../../src/document/align.ts";
import { normalizeMarkdown } from "../../src/document/normalizer.ts";

const page = (pageIndex: number, md: string) => {
  const p = normalizeMarkdown(md);
  return { pageIndex, text: p.text, blocks: p.blocks };
};

const window = (...pages: Array<{ pageIndex: number; text: string; blocks: unknown }>) =>
  indexPages(pages as Parameters<typeof indexPages>[0]);

describe("normalizeForMatch", () => {
  it("maps offsets back into the original text", () => {
    const raw = "The ﬁnal line, don't stop";
    const n = normalizeForMatch(raw);
    expect(n.normalized).toBe("The final line, don't stop");
    const at = n.normalized.indexOf("final");
    expect(toOriginalOffset(n, at)).toBe(4);
    // "final" starts at 4 in "The final line, don't stop"; the ﬁ ligature made
    // the normalized form longer, and the map still lands on the right offsets.
    expect(toOriginalRange(n, at, at + 5)).toEqual({ start: 4, end: 9 });
    expect(n.source.slice(toOriginalRange(n, at, at + 5).start, toOriginalRange(n, at, at + 5).end)).toBe("final");
  });

  it("collapses whitespace runs but keeps a single space as a boundary", () => {
    const n = normalizeForMatch("  a \n\t b  ");
    expect(n.normalized).toBe("a b");
  });

  it("keeps real hyphens for matching", () => {
    expect(normalizeForMatch("well-known").normalized).toBe("well-known");
  });

  it("removes soft hyphens and zero-width characters", () => {
    expect(normalizeForMatch("so\u00ADft\u200Bword").normalized).toBe("softword");
  });

  it("normalizes every apostrophe variant to one character", () => {
    expect(normalizeForMatch("don\u2019t don\u02BCt don\u2018t").normalized).toBe("don't don't don't");
  });
});

describe("alignSelection", () => {
  it("aligns a unique match and returns original offsets", () => {
    const md = "The cat sat on the mat.\n\nA dog barked loudly.";
    const target = page(4, md);
    const r = alignSelection({ selection: "dog barked", selectionPageIndex: 4, pages: window(target) });
    expect(r.status).toBe("aligned");
    if (r.status !== "aligned") return;
    expect(r.pageIndex).toBe(4);
    expect(target.text.slice(r.start, r.end)).toBe("dog barked");
    expect(r.kind).toBe("unique");
  });

  it("matches across a whitespace difference in the PDF.js layer", () => {
    const target = page(0, "Reading a book slowly improves vocabulary.");
    const r = alignSelection({ selection: "Reading\na   book", selectionPageIndex: 0, pages: window(target) });
    expect(r.status).toBe("aligned");
  });

  it("finds a neighbouring page, because parser order can differ from reading order", () => {
    const pages = window(page(9, "The final sentence ends here."));
    const r = alignSelection({ selection: "final sentence", selectionPageIndex: 8, pages });
    expect(r.status).toBe("aligned");
    if (r.status !== "aligned") return;
    expect(r.pageIndex).toBe(9);
  });

  it("searches only the pages it was given", () => {
    const target = page(2, "A phrase on a later page.");
    const r = alignSelection({ selection: "later page", selectionPageIndex: 2, pages: window(page(2, "unrelated")) });
    expect(r).toEqual({ status: "not-found", reason: "no-match-in-window", candidates: 0 });
    expect(target.pageIndex).toBe(2);
  });

  describe("ambiguity", () => {
    const repeated = () =>
      window(
        page(
          1,
          "He said the word again. Then he said the word again. Finally he said the word again.",
        ),
      );

    it("abstains on a repeated phrase with no distinguishing context", () => {
      const r = alignSelection({ selection: "said the word again", selectionPageIndex: 1, pages: repeated() });
      expect(r.status).toBe("ambiguous");
      if (r.status !== "ambiguous") return;
      expect(r.reason).toContain("without-distinguishing-context");
      expect(r.candidates).toBe(3);
    });

    it("resolves a repeated phrase with a matching prefix and suffix", () => {
      const r = alignSelection({
        selection: "said the word again",
        selectionPageIndex: 1,
        prefix: "Finally he",
        suffix: "",
        pages: repeated(),
      });
      expect(r.status).toBe("aligned");
      if (r.status !== "aligned") return;
      expect(r.kind).toBe("prefix-suffix");
      expect(r.start).toBeGreaterThan(40);
    });

    it("stays ambiguous when the stored context matches more than one place", () => {
      const r = alignSelection({
        selection: "said the word again",
        selectionPageIndex: 1,
        prefix: "he",
        pages: repeated(),
      });
      expect(r.status).toBe("ambiguous");
      if (r.status !== "ambiguous") return;
      expect(r.reason).toContain("context-matched-more-than-once");
    });

    it("abstains when the stored context matches nothing at all", () => {
      const r = alignSelection({
        selection: "said the word again",
        selectionPageIndex: 1,
        prefix: "Nowhere near",
        pages: repeated(),
      });
      expect(r.status).toBe("ambiguous");
      if (r.status !== "ambiguous") return;
      expect(r.reason).toContain("did-not-match");
    });

    it("does not match a phrase inside a longer word", () => {
      // "the cat" occurs only inside "the catalog", "the catalogue" and "the
      // cathedral". A substring hit here would be a wrong high-confidence
      // context, so the match must land on word boundaries or not at all.
      const pages = window(page(3, "The catalog entry, the catalogue entry, and the cathedral door."));
      expect(alignSelection({ selection: "the cat", selectionPageIndex: 3, pages })).toEqual({
        status: "not-found",
        reason: "no-match-in-window",
        candidates: 0,
      });
    });

    it("still matches a phrase that also appears inside a longer word", () => {
      // Word-boundary matching removes the substrings but must not remove the
      // one real occurrence.
      const pages = window(page(3, "The catalog entry and the catalogue entry differ. He read the cat."));
      const r = alignSelection({ selection: "the cat", selectionPageIndex: 3, pages });
      expect(r.status).toBe("aligned");
      if (r.status !== "aligned") return;
      expect(r.matchedText).toBe("the cat");
      expect(r.context).toBe("He read the cat.");
    });
  });

  describe("do not join unrelated adjacent text", () => {
    it("will not match across two blocks", () => {
      const target = page(0, "Column one ends here.\n\nColumn two begins here.");
      const r = alignSelection({ selection: "ends here Column two", selectionPageIndex: 0, pages: window(target) });
      expect(r).toEqual({ status: "not-found", reason: "no-match-in-window", candidates: 0 });
    });

    it("will not match a header and the first body line as one phrase", () => {
      const target = page(5, "Chapter 7 Rivers\n\nThe river began at the source.");
      const r = alignSelection({ selection: "7 Rivers The river", selectionPageIndex: 5, pages: window(target) });
      expect(r.status).toBe("not-found");
    });

    it("will not match a footer onto the last body line", () => {
      const target = page(5, "The last line of the body text.\n\n42 Rivers of the North");
      const r = alignSelection({ selection: "body text 42 Rivers", selectionPageIndex: 5, pages: window(target) });
      expect(r.status).toBe("not-found");
    });

    it("will not match across a page boundary", () => {
      const pages = window(page(1, "The sentence stops at the end of"), page(2, "this page and continues there."));
      const r = alignSelection({ selection: "end of this page", selectionPageIndex: 1, pages });
      expect(r.status).toBe("not-found");
    });
  });

  describe("hyphenation", () => {
    it("preserves a real hyphen when the joined form is absent", () => {
      const target = page(0, "It was a well-known problem in the trade.");
      const r = alignSelection({ selection: "well-known", selectionPageIndex: 0, pages: window(target) });
      expect(r.status).toBe("aligned");
      if (r.status !== "aligned") return;
      expect(r.matchedText).toBe("well-known");
      expect(r.kind).toBe("unique");
    });

    it("reverses a line-end hyphen only with the de-hyphenated form as evidence", () => {
      // The PDF.js layer yields "scarlet- red" for a word broken across lines;
      // the page really spells it "scarletred", which is the supporting evidence.
      const target = page(0, "The coat was scarletred, a dye long used in wool.");
      const r = alignSelection({ selection: "scarlet- red", selectionPageIndex: 0, pages: window(target) });
      expect(r.status).toBe("aligned");
      if (r.status !== "aligned") return;
      expect(r.kind).toBe("hyphenated");
      expect(target.text.slice(r.start, r.end)).toBe("scarletred");
    });

    it("leaves an unsupported hyphenation unmatched instead of guessing", () => {
      // "red" is not in this page, so no variant has evidence and nothing is joined.
      const target = page(0, "The coat was scarlet and the colour was scarlet too.");
      expect(alignSelection({ selection: "scarlet- red", selectionPageIndex: 0, pages: window(target) }).status).toBe("not-found");
    });

    it("never guesses the continuation of a selection that ends in a hyphen", () => {
      // The trailing hyphen is all the user selected; the rest of the word is
      // unknown, so this must not align even when a joined form exists.
      const target = page(0, "It was a wellknown problem in the trade.");
      expect(alignSelection({ selection: "well-", selectionPageIndex: 0, pages: window(target) }).status).toBe("not-found");
    });
  });

  describe("garbled pages", () => {
    it("refuses to anchor a quote in text full of replacement characters", () => {
      const target = page(0, `Some text \uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD with the word somewhere`);
      const r = alignSelection({ selection: "with the word", selectionPageIndex: 0, pages: window(target) });
      expect(r).toEqual({ status: "not-found", reason: "page-text-contains-replacement-characters", candidates: 1 });
    });
  });

  it("returns sentence context inside the matched block", () => {
    const target = page(0, "First sentence here. The second sentence holds the word. Third sentence.");
    const r = alignSelection({ selection: "holds the word", selectionPageIndex: 0, pages: window(target) });
    expect(r.status).toBe("aligned");
    if (r.status !== "aligned") return;
    expect(r.context).toBe("The second sentence holds the word.");
  });

  it("reports an empty or unmatchable selection instead of throwing", () => {
    expect(alignSelection({ selection: "   ", selectionPageIndex: 0, pages: window(page(0, "x")) }).status).toBe("not-found");
    expect(alignSelection({ selection: "��", selectionPageIndex: 0, pages: window(page(0, "x")) }).status).toBe("not-found");
  });
});
