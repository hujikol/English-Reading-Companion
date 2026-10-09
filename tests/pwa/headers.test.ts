import headersRaw from "../../public/_headers?raw";
import { describe, expect, it } from "vitest";

/**
 * Reads the real `public/_headers` file rather than restating the policy in
 * test code, so a loosened header fails CI instead of shipping. Loaded with
 * Vite's `?raw` so no node types are needed.
 */
const file = headersRaw;

type Rule = { pattern: string; headers: Record<string, string> };

function parse(text: string): Rule[] {
  const rules: Rule[] = [];
  let current: Rule | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    // Indentation, not content, distinguishes a pattern from a header line.
    if (!/^\s/.test(raw)) {
      current = { pattern: line, headers: {} };
      rules.push(current);
      continue;
    }
    const idx = line.indexOf(":");
    if (!current || idx < 0) throw new Error(`unparsable header line: ${raw}`);
    current.headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return rules;
}

const rules = parse(file);
const ruleFor = (pattern: string): Rule => {
  const found = rules.find((r) => r.pattern === pattern);
  if (!found) throw new Error(`no rule for ${pattern}`);
  return found;
};
const csp = (): string => ruleFor("/*").headers["content-security-policy"] ?? "";

const directive = (name: string): string[] => {
  const found = csp()
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `));
  if (!found) throw new Error(`no ${name} directive`);
  return found.slice(name.length + 1).trim().split(/\s+/);
};

describe("hosting headers", () => {
  it("ships a CSP on every path", () => {
    expect(csp()).not.toBe("");
  });

  it("allows only self-hosted scripts and no unsafe-eval", () => {
    // 'wasm-unsafe-eval' is required by WebAssembly.compile; 'unsafe-eval' is not.
    expect(directive("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(csp()).not.toMatch(/[^-\w]unsafe-eval/);
    expect(csp()).not.toMatch(/script-src[^;]*https?:/);
  });

  it("limits workers to self and forbids remote documents", () => {
    expect(directive("worker-src")).toEqual(["'self'"]);
    expect(directive("default-src")).toEqual(["'self'"]);
    expect(directive("object-src")).toEqual(["'none'"]);
    expect(directive("frame-src")).toEqual(["'none'"]);
    expect(directive("frame-ancestors")).toEqual(["'none'"]);
    expect(directive("base-uri")).toEqual(["'none'"]);
    expect(directive("form-action")).toEqual(["'none'"]);
  });

  it("scopes connect-src to the explicit translation and model-download hosts", () => {
    const connect = directive("connect-src");
    expect(connect[0]).toBe("'self'");
    expect(connect.slice(1).every((o) => /^https:\/\/[a-z0-9.-]+$/.test(o))).toBe(true);
    expect(connect).toEqual(["\'self\'", "https://api.mymemory.translated.net", "https://huggingface.co", "https://us.aws.cdn.hf.co"]);
  });

  it("keeps fonts and manifest self-hosted", () => {
    expect(directive("font-src")).toEqual(["'self'"]);
    expect(directive("manifest-src")).toEqual(["'self'"]);
    expect(directive("img-src")).toEqual(["'self'", "data:"]);
  });

  it("marks hashed assets immutable and the entry points revalidating", () => {
    expect(ruleFor("/assets/*").headers["cache-control"]).toContain("immutable");
    expect(ruleFor("/assets/*").headers["cache-control"]).toContain("max-age=31536000");
    for (const p of ["/index.html", "/sw.js", "/manifest.webmanifest"]) {
      expect(ruleFor(p).headers["cache-control"]).toBe("no-cache");
    }
  });

  it("declares MIME types for wasm and module scripts", () => {
    expect(ruleFor("/assets/*.wasm").headers["content-type"]).toBe("application/wasm");
    expect(ruleFor("/assets/*.mjs").headers["content-type"]).toContain("text/javascript");
    expect(ruleFor("/assets/*.js").headers["content-type"]).toContain("text/javascript");
  });

  it("sets the hardening baseline", () => {
    const all = ruleFor("/*").headers;
    expect(all["x-content-type-options"]).toBe("nosniff");
    expect(all["referrer-policy"]).toBe("no-referrer");
    expect(all["strict-transport-security"]).toContain("max-age=");
    expect(all["permissions-policy"]).toContain("camera=()");
  });
});