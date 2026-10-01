import { describe, expect, it } from "vitest";
import { markdownDocument, markdownToHtml, parseMarkdown } from "../../src/features/reader/text/markdown.ts";
import { MAX_MATCHES, resolveAnchorIn, resolveQuote } from "../../src/features/reader/text/quote-resolve.ts";

const LOCAL = (href: string) => (href.startsWith("images/") ? `blob:reader/${href}` : null);

describe("markdown: raw HTML is disabled (s8)", () => {
  const HOSTILE: [name: string, input: string][] = [
    ["inline script", `Hello <script>alert(1)</script> world`],
    ["html attribute breakout", `<img src=x onerror=alert(1)>`],
    ["iframe", `<iframe src="https://evil.example.com"></iframe>`],
    ["svg", `<svg onload="alert(1)"></svg>`],
    ["style block", `<style>body{background:url(https://t.example.com/x)}</style>`],
    ["form", `<form action="https://evil.example.com"><input name="a"></form>`],
    ["html comment with markup", `<!-- <script>alert(1)</script> -->`],
    ["javascript link", `[click](javascript:alert(1))`],
    ["data uri link", `[x](data:text/html;base64,PHNjcmlwdD4=)`],
    ["file link", `[x](file:///etc/passwd)`],
    ["custom scheme link", `[x](myapp://do-thing)`],
  ];

  for (const [name, input] of HOSTILE) {
    it(`neutralizes ${name}`, () => {
      const result = markdownToHtml(input, { resolveResource: LOCAL });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.html).not.toMatch(/<script/i);
      expect(result.html).not.toMatch(/\son[a-z]+\s*=/i);
      expect(result.html).not.toMatch(/javascript\s*:/i);
      expect(result.html).not.toMatch(/data:text\/html/i);
      expect(result.html).not.toMatch(/file:\/\//i);
      expect(result.html).not.toMatch(/myapp:/i);
      expect(result.html).not.toMatch(/evil\.example\.com/);
      expect(result.html).not.toMatch(/<iframe|<svg|<form|<input|<style/i);
    });
  }

  it("renders ordinary Markdown", () => {
    const result = markdownToHtml("# Title\n\nSome *emphasis* and `code`.\n\n- one\n- two");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain("<h1>Title</h1>");
    expect(result.html).toContain("<em>emphasis</em>");
    expect(result.html).toContain("<code>code</code>");
    expect(result.html).toContain("<li>one</li>");
  });

  it("does not execute or highlight code blocks", () => {
    const result = markdownToHtml("```html\n<script>alert(1)</script>\n```");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).not.toMatch(/<script/i);
    expect(result.html).toContain("&lt;script&gt;");
  });

  it("disables remote images by default and keeps local ones", () => {
    const result = markdownToHtml(
      `![local](images/a.png)\n\n![remote](https://tracker.example.com/p.gif)`,
      { resolveResource: LOCAL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain("blob:reader/images/a.png");
    expect(result.html).not.toMatch(/tracker\.example\.com/);
  });

  it("drops relative references the resolver rejects", () => {
    const result = markdownToHtml(`[a](other/page.xhtml)`, { resolveResource: LOCAL });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).not.toMatch(/other\/page\.xhtml/);
    expect(result.html).toContain("a");
  });
});

describe("markdown: source offsets and stable block IDs (s8)", () => {
  const SOURCE = "# Chapter 1\n\nFirst body paragraph.\n\n## Section\n\nSecond body paragraph.";

  it("slices back to the exact source span for every block", () => {
    for (const block of parseMarkdown(SOURCE)) {
      expect(SOURCE.slice(block.start, block.end)).toBe(block.text);
    }
  });

  it("gives every block a distinct, offset-derived ID", () => {
    const blocks = parseMarkdown(SOURCE);
    expect(new Set(blocks.map((b) => b.blockId)).size).toBe(blocks.length);
    for (const block of blocks) expect(block.blockId).toBe(`md-${block.start}-${block.line}`);
    expect(parseMarkdown(SOURCE).map((b) => b.blockId)).toEqual(blocks.map((b) => b.blockId));
  });

  it("labels headings without making them the locator", () => {
    const blocks = parseMarkdown(SOURCE);
    expect(blocks.filter((b) => b.kind === "heading")).toHaveLength(2);
    expect(blocks[0]?.blockId).not.toBe("Chapter 1");
  });

  it("keeps duplicate headings addressable by offset", () => {
    const blocks = parseMarkdown("# Chapter 1\n\na\n\n# Chapter 1\n\nb");
    const headings = blocks.filter((b) => b.kind === "heading");
    expect(headings).toHaveLength(2);
    expect(headings[0]?.blockId).not.toBe(headings[1]?.blockId);
  });

  it("records offsets for lists, quotes and code", () => {
    const source = "- a\n- b\n\n> quoted\n\n```\ncode\n```";
    const blocks = parseMarkdown(source);
    expect(blocks.map((b) => b.kind).sort()).toEqual(["blockquote", "code", "list"]);
    for (const block of blocks) expect(source.slice(block.start, block.end)).toBe(block.text);
  });

  it("exposes sanitized HTML alongside offsets", () => {
    const doc = markdownDocument(SOURCE, { resolveResource: LOCAL });
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    expect(doc.html).toContain("<h1>");
    expect(doc.blocks.length).toBeGreaterThan(0);
  });

  it("rejects an oversized document before parsing", () => {
    const result = markdownToHtml("#x\n\ntext", { maxChars: 4 });
    expect(result.ok).toBe(false);
  });
});

describe("quote resolution: unique match resolves (D1 exit)", () => {
  it("resolves an unambiguous quote", () => {
    const source = "The quick brown fox jumps over the lazy dog and keeps running for a while.";
    const quote = "jumps over the lazy dog";
    const result = resolveQuote(source, { quote });
    expect(result).toEqual({ resolved: true, start: source.indexOf(quote), end: source.indexOf(quote) + quote.length, via: "exact", occurrence: 0 });
  });

  it("resolves inside a block's own text", () => {
    const source = "First paragraph with a soft line break.\n\nSecond paragraph here.";
    const result = resolveQuote(source, { quote: "Second paragraph" });
    expect(result.resolved).toBe(true);
  });

  it("reports an empty quote as unresolvable rather than offset zero", () => {
    expect(resolveQuote("anything", { quote: "" })).toEqual({ resolved: false, reason: "empty-quote" });
  });

  it("abstains when the text is gone", () => {
    expect(resolveQuote("completely different text", { quote: "missing phrase" })).toEqual({
      resolved: false,
      reason: "no-match",
    });
  });

  it("survives a typography change through normalized matching", () => {
    const original = "It’s a “quoted” phrase with a ligature: office.";
    const retypeset = "It's a \"quoted\" phrase with a ligature: ofﬁce.";
    const result = resolveQuote(retypeset, { quote: "It’s a “quoted” phrase with a ligature: ofﬁce." });
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expect(result.via).toBe("normalized");
    expect(retypeset.slice(result.start, result.end)).toContain("quoted");
  });

  it("preserves real hyphens instead of guessing at dehyphenation", () => {
    const source = "a well-known state-of-the-art method";
    const result = resolveQuote(source, { quote: "well-known" });
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expect(source.slice(result.start, result.end)).toBe("well-known");
  });

  it("maps offsets back to source characters, not normalized positions", () => {
    const source = "a  b   c";
    const result = resolveQuote(source, { quote: "b" });
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expect(result.start).toBe(3);
    expect(source.slice(result.start, result.end)).toBe("b");
  });
});

describe("quote resolution: ambiguity abstains, never guesses (s7)", () => {
  const source = "the cat sat. the cat ran. the cat slept.";

  it("abstains on a duplicate quote with no context", () => {
    expect(resolveQuote(source, { quote: "the cat" })).toEqual({ resolved: false, reason: "ambiguous" });
  });

  it("disambiguates duplicates with a prefix", () => {
    // "sat. " is the text BEFORE the second occurrence, so the first is rejected.
    const result = resolveQuote(source, { quote: "the cat", prefix: "sat. " });
    expect(result).toEqual({ resolved: true, start: 13, end: 20, via: "exact", occurrence: 1 });
  });

  it("disambiguates duplicates with a suffix", () => {
    const result = resolveQuote(source, { quote: "the cat", suffix: " ran." });
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expect(source.slice(result.start, result.end)).toBe("the cat");
    expect(result.start).toBe(13);
  });

  it("abstains when neither prefix nor suffix picks a winner", () => {
    // The quote is present 3 times and no occurrence matches the context.
    expect(resolveQuote(source, { quote: "the cat", prefix: "nothing like this" })).toEqual({
      resolved: false,
      reason: "ambiguous",
    });
  });

  it("abstains when context matches more than one occurrence", () => {
    const doubled = "x the cat y. z the cat q.";
    expect(resolveQuote(doubled, { quote: "the cat", suffix: " y." }).resolved).toBe(true);
    const identical = "the cat the cat";
    expect(resolveQuote(identical, { quote: "the cat", prefix: "" })).toEqual({ resolved: false, reason: "ambiguous" });
  });

  it("abstains rather than scanning unbounded repetition", () => {
    const many = "x".repeat(MAX_MATCHES + 10);
    expect(resolveQuote(many, { quote: "x" }).resolved).toBe(false);
  });

  it("compares only the tail of a long stored prefix", () => {
    // Only the final 64 characters are compared, so a prefix may legitimately
    // be long as long as its tail is the real preceding context.
    const long = `${"A".repeat(200)} the cat sat.`;
    expect(resolveQuote(long, { quote: "the cat", prefix: `${"A".repeat(200)} ` })).toMatchObject({
      resolved: true,
      occurrence: 0,
      via: "exact",
    });
  });

  it("abstains when a long prefix tail does not match the real context", () => {
    // The compared tail here is filler, which precedes no occurrence.
    expect(resolveQuote(source, { quote: "the cat", prefix: `${"filler ".repeat(200)}sat. ` })).toEqual({
      resolved: false,
      reason: "ambiguous",
    });
  });
});

describe("quote resolution: Track E contract shape (E2)", () => {
  it("returns exactly {resolved,start,end} plus diagnostics", () => {
    const resolved = resolveQuote("unique text here", { quote: "unique text" });
    expect(resolved.resolved).toBe(true);
    if (!resolved.resolved) return;
    expect(Object.keys(resolved).sort()).toEqual(["end", "occurrence", "resolved", "start", "via"]);
    const abstained = resolveQuote("unique text here", { quote: "absent" });
    expect(Object.keys(abstained).sort()).toEqual(["reason", "resolved"]);
  });

  it("maps an abstention onto anchorState unresolved", () => {
    const out = resolveAnchorIn("some text", { quote: "nope" });
    expect(out).toEqual({ state: "unresolved", reason: "no-match" });
    const hit = resolveAnchorIn("some text", { quote: "some" });
    expect(hit.state).toBe("resolved");
  });
});
