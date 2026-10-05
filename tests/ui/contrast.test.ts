import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Contrast is a design decision that silently rots: a token gets darkened for
 * aesthetics, or a new pair is introduced without checking it, and nothing in
 * the build fails. These are measured from the real stylesheet, so editing a
 * token without re-checking it fails here.
 */

/** WCAG relative luminance. */
const luminance = (hex: string): number => {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const channel = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
};

const contrast = (a: string, b: string): number => {
  const sorted = [luminance(a), luminance(b)].sort((x, y) => y - x);
  const hi = sorted[0]!;
  const lo = sorted[1]!;
  return (hi + 0.05) / (lo + 0.05);
};

const css = readFileSync("src/app.css", "utf8");

/** The value a token is overridden to inside the body block, or its @theme default. */
const token = (name: string): string => {
  const override = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`, "m"));
  if (override?.[1] !== undefined) return override[1];
  const themed = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`, "m"));
  if (themed?.[1] !== undefined) return themed[1];
  throw new Error(`token --color-${name} not found in src/app.css`);
};

describe("colour contrast", () => {
  const paper = "#ffffff";

  it("body text on a card clears 4.5:1", () => {
    expect(contrast(token("ink"), paper)).toBeGreaterThanOrEqual(4.5);
  });

  it("secondary text clears 4.5:1 on both surfaces", () => {
    expect(contrast(token("ink-soft"), paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("ink-soft"), token("shell"))).toBeGreaterThanOrEqual(4.5);
  });

  it("the primary button label clears 4.5:1 on the accent", () => {
    expect(contrast(paper, token("accent"))).toBeGreaterThanOrEqual(4.5);
  });

  it("accent text on its own tint clears 4.5:1", () => {
    expect(contrast(token("accent"), token("accent-soft"))).toBeGreaterThanOrEqual(4.5);
  });

  it("the error colour clears 4.5:1", () => {
    expect(contrast("#b42318", paper)).toBeGreaterThanOrEqual(4.5);
  });

  it("focus ring is visible against the page", () => {
    // The focus indicator must be discernible against BOTH the app background
    // and the white page a reader selects text on.
    expect(contrast(token("accent"), token("shell"))).toBeGreaterThanOrEqual(3);
    expect(contrast(token("accent"), paper)).toBeGreaterThanOrEqual(3);
  });
});

describe("the shell has a definite height", () => {
  // The reader is `height: 100%` inside a flex column that scrolls internally.
  // An auto-height ancestor makes that percentage resolve against nothing, the
  // column stops constraining, and the toolbar scrolls out of view.
  it("gives html, body and #root a full height", () => {
    expect(css).toMatch(/html,\s*\n\s*body,\s*\n\s*#root\s*\{[^}]*height:\s*100%/);
  });

  it("never removes the focus outline", () => {
    expect(css).not.toMatch(/outline:\s*(none|0)\b/);
  });
});