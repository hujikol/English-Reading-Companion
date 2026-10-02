import { describe, expect, it } from "vitest";
import { sanitizeChapter } from "../../src/features/reader/epub/sanitize.ts";

/**
 * Regression: a realistic chapter head.
 *
 * `link` and `meta` are void elements, so they never have a closing tag. The
 * sanitizer used to treat every dropped tag except `br`/`hr`/`img`/`col`/`wbr`
 * as content-dropping, which meant it scanned forward for `</link`, found none,
 * and consumed the entire chapter. Any real book has a `<link rel=stylesheet>`
 * in its head, so every real EPUB rendered blank — and threw outright.
 */
const REAL_CHAPTER = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <title>The Crossing</title>
    <link rel="stylesheet" type="text/css" href="../styles/main.css"/>
    <meta charset="utf-8"/>
    <meta name="cover" content="cover.jpg"/>
    <base href="https://example.invalid/"/>
  </head>
  <body>
    <h1>The Crossing</h1>
    <p>The ferry left the harbour at dawn.</p>
    <p>The wake lasted a long time.</p>
    <img src="images/ferry.jpg" alt="A ferry"/>
    <hr/>
  </body>
</html>`;

/** Strip tags so assertions are about surviving TEXT, not about markup shape. */
const textOf = (xhtml: string): string => {
  const result = sanitizeChapter(xhtml);
  if (!result.ok) throw new Error(`sanitize rejected: ${result.reason}`);
  return result.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
};

const htmlOf = (xhtml: string): string => {
  const result = sanitizeChapter(xhtml);
  if (!result.ok) throw new Error(`sanitize rejected: ${result.reason}`);
  return result.html;
};

describe("sanitizeChapter: void elements in a realistic chapter head", () => {
  it("does not throw", () => {
    expect(() => sanitizeChapter(REAL_CHAPTER)).not.toThrow();
  });

  it("keeps the prose after a stylesheet link and meta tags", () => {
    expect(textOf(REAL_CHAPTER)).toContain("The ferry left the harbour at dawn.");
    expect(textOf(REAL_CHAPTER)).toContain("The wake lasted a long time.");
  });

  it("keeps the heading", () => {
    expect(textOf(REAL_CHAPTER)).toContain("The Crossing");
  });

  it("drops the base tag's remote href", () => {
    expect(htmlOf(REAL_CHAPTER)).not.toContain("example.invalid");
  });

  it("survives each void tag on its own", () => {
    for (const tag of ["link", "meta", "base", "source", "track", "area", "embed", "param", "input", "wbr"]) {
      const chapter = `<html><head><${tag} name="x" content="y"/></head><body><p>Prose survives ${tag}.</p></body></html>`;
      expect(textOf(chapter), `${tag} swallowed the chapter`).toContain(`Prose survives ${tag}.`);
    }
  });

  it("still consumes a script body to its close tag", () => {
    // The other half of the fix: script must NOT be dropped as a bare tag, or
    // its source text would leak into the rendered chapter.
    const chapter = `<html><body><p>Before.</p><script>var pwned = 1;</script><p>After.</p></body></html>`;
    expect(htmlOf(chapter)).not.toContain("pwned");
    expect(textOf(chapter)).not.toContain("pwned");
    expect(textOf(chapter)).toContain("Before.");
    expect(textOf(chapter)).toContain("After.");
  });

  it("still consumes a style body", () => {
    const chapter = `<html><body><style>p { color: red }</style><p>Kept.</p></body></html>`;
    expect(htmlOf(chapter)).not.toContain("color: red");
  });

  it("still consumes an iframe body rather than leaking its fallback text", () => {
    // iframe is NOT void, so it keeps content-dropping: its fallback content
    // must not survive into the rendered chapter.
    const chapter = `<html><body><p>Kept.</p><iframe src="https://example.invalid">fallback</iframe></body></html>`;
    const text = textOf(chapter);
    expect(text).not.toContain("fallback");
    expect(text).toContain("Kept.");
  });
});
