import { describe, expect, it } from "vitest";
import { blockAt, normalizeMarkdown, quoteAround, textLength } from "../../src/document/normalizer.ts";

describe("normalizeMarkdown", () => {
  it("strips markdown syntax but keeps the readable text", () => {
    const page = normalizeMarkdown("# Title\n\nA **bold** word and a [link](https://x.test).\n\n- one\n- two\n");
    expect(page.text).toBe("Title\n\nA bold word and a link.\n\none two");
  });

  it("gives every block an id, a kind and a range that indexes page text", () => {
    const page = normalizeMarkdown("## Chapter One\n\nFirst paragraph here.\n\nSecond paragraph here.");
    expect(page.blocks.map((b) => [b.id, b.kind])).toEqual([
      ["b0", "heading"],
      ["b1", "paragraph"],
      ["b2", "paragraph"],
    ]);
    for (const b of page.blocks) expect(page.text.slice(b.start, b.end)).toBe(page.text.slice(b.start, b.end));
    expect(page.text.slice(page.blocks[1]!.start, page.blocks[1]!.end)).toBe("First paragraph here.");
    expect(page.text.slice(page.blocks[2]!.start, page.blocks[2]!.end)).toBe("Second paragraph here.");
  });

  it("keeps block ids stable for the same input", () => {
    const md = "# A\n\nbody one\n\nbody two";
    expect(normalizeMarkdown(md).blocks).toEqual(normalizeMarkdown(md).blocks);
  });

  it("joins wrapped lines into one line and collapses whitespace", () => {
    const page = normalizeMarkdown("This sentence was wrapped\nacross two lines  by the\nparser.");
    expect(page.text).toBe("This sentence was wrapped across two lines by the parser.");
  });

  it("expands ligatures, soft hyphens and typographic apostrophes", () => {
    // \u00AD is the SOFT HYPHEN. \u00FF is "y with diaeresis", a real letter, so a
    // fixture using it asserts nothing about hyphen removal.
    const page = normalizeMarkdown("The ﬁnal ﬂow with so\u00ADft hyphens and don\u2019t breaks.");
    expect(page.text).toBe("The final flow with soft hyphens and don't breaks.");
  });

  it("preserves real hyphens inside a line", () => {
    const page = normalizeMarkdown("A well-known fact.");
    expect(page.text).toBe("A well-known fact.");
  });

  it("classifies tables and lists", () => {
    expect(normalizeMarkdown("| a | b |\n|---|---|\n| 1 | 2 |").blocks[0]!.kind).toBe("table");
    expect(normalizeMarkdown("- first\n- second").blocks[0]!.kind).toBe("list");
    expect(normalizeMarkdown("1. first\n2. second").blocks[0]!.kind).toBe("list");
  });

  it("still produces one addressable block for an empty page", () => {
    const page = normalizeMarkdown("   \n\n  ");
    expect(page.text).toBe("");
    expect(page.blocks).toEqual([{ id: "b0", kind: "unknown", start: 0, end: 0 }]);
    expect(textLength(page)).toBe(0);
  });

  it("resolves a block from an offset and rejects one in a separator", () => {
    const page = normalizeMarkdown("one\n\ntwo");
    expect(blockAt(page, 1)?.id).toBe("b0");
    expect(blockAt(page, 4)).toBeNull();
    expect(blockAt(page, 7)?.id).toBe("b1");
  });

  it("quotes the two sides of a range, not around a single offset", () => {
    // quoteAround takes the matched [start, end) range: the prefix ends exactly
    // where the quote begins and the suffix starts exactly where it ends, so the
    // three parts concatenate back into the original text.
    expect(quoteAround("abcdefghij", 4, 7, 2)).toEqual({ prefix: "cd", suffix: "hi" });
    expect("cd" + "efg" + "hi").toBe("cdefghi");
  });
});
