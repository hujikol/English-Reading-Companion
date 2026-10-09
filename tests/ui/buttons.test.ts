import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BTN_BASE, BTN, BTN_ICON, BTN_SM, BTN_PRIMARY, BTN_SECONDARY } from "../../src/ui/styles.ts";

/**
 * Two defects this pass fixed, pinned so they cannot come back:
 *
 * 1. A blanket `.reader button` rule painted every reader button solid ink.
 *    Any per-button utility class was then overridden by specificity, so
 *    primary and secondary looked identical regardless of their role — the
 *    "unclear button contrast" report. It is gone; buttons are styled per role.
 *
 * 2. Removing that rule left 8 buttons with no styling at all, because they had
 *    been relying on it. A bare <button> renders as an unstyled native control
 *    with a ~21px target.
 */

const files = [
  "src/app/ReaderScreen.tsx",
  "src/ui/SelectionPopover.tsx",
  "src/app/LibraryScreen.tsx",
  "src/app/VocabularyScreen.tsx",
  "src/app/ReviewScreen.tsx",
].map((f) => readFileSync(f, "utf8"));

/**
 * Opening tags of `<button …>`, scanned with brace awareness.
 *
 * A regex alone is wrong here twice over: `[^>]*` stops at the `>` inside an
 * arrow function, and a lazy match runs past the tag into the next element.
 */
function buttonTags(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/<button\b/g)) {
    let depth = 0;
    let i = m.index;
    while (i < source.length) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth <= 0) break;
      i++;
    }
    out.push(source.slice(m.index, i + 1));
  }
  return out;
}

describe("no button is left unstyled", () => {
  it("every <button> carries a className", () => {
    const bare: string[] = [];
    files.forEach((s, i) => {
      for (const tag of buttonTags(s)) {
        if (!tag.includes("className")) bare.push(`${i}: ${tag.replace(/\s+/g, " ").slice(0, 70)}`);
      }
    });
    expect(bare).toEqual([]);
  });

  it("the reader has no blanket button rule that could override a role", () => {
    const css = readFileSync("src/app.css", "utf8");
    expect(css).not.toMatch(/^\.reader button\s*[,{]/m);
  });
});

describe("button roles", () => {
  it("every role carries the shared base, so touch size cannot drift", () => {
    for (const role of [BTN, BTN_ICON, BTN_SM, BTN_PRIMARY, BTN_SECONDARY]) {
      expect(role).toContain(BTN_BASE);
    }
  });

  it("default and icon targets meet the 44px touch minimum", () => {
    expect(BTN).toContain("min-h-11");
    expect(BTN_ICON).toContain("h-11");
    expect(BTN_ICON).toContain("w-11");
  });

  it("dense toolbar buttons stay above the 32px precision-pointer floor", () => {
    expect(BTN_SM).toContain("min-h-8");
    expect(BTN_SM).not.toContain("min-h-7");
  });

  it("disabled state is unmistakable, not merely dimmed", () => {
    expect(BTN_BASE).toContain("disabled:opacity-45");
    expect(BTN_BASE).toContain("disabled:cursor-not-allowed");
  });

  it("focus is always visible", () => {
    expect(BTN_BASE).toContain("focus-visible:outline-2");
  });

  it("primary and secondary differ by fill AND border, not colour alone", () => {
    // Colour-only differentiation fails in greyscale and for colour-vision
    // deficiency; the outline is the non-colour signal.
    expect(BTN_PRIMARY).toContain("bg-accent");
    expect(BTN_SECONDARY).toContain("border");
    expect(BTN_SECONDARY).not.toContain("bg-accent");
  });
});

describe("typography floor", () => {
  it("no text below 12px anywhere in the UI", () => {
    const offenders: string[] = [];
    files.forEach((s, i) => {
      for (const m of s.matchAll(/text-\[(\d+)px\]/g)) {
        if (Number(m[1]) < 12) offenders.push(`${i}: ${m[0]}`);
      }
    });
    expect(offenders).toEqual([]);
  });
});