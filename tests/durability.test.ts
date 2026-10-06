import { describe, expect, it } from "vitest";
import { DURABILITY, isEvictable } from "../src/contracts/index.ts";

describe("durability tiers", () => {
  it("never marks user data as evictable", () => {
    for (const t of ["documents", "progress", "bookmarks", "marks", "vocabulary", "explanations"] as const) {
      expect(isEvictable(t)).toBe(false);
    }
  });

  it("treats derived pages and ai cache as evictable", () => {
    expect(isEvictable("semanticPages")).toBe(true);
    expect(isEvictable("aiCache")).toBe(true);
  });

  it("covers exactly the Section 12 tables", () => {
    // ponytail: explicit list, not a count — a count passes while a table goes missing.
    // upgrade: a table added or renamed updates this list in the same commit; this
    // test failing is the intended signal, not a flake to relax.
    expect(Object.keys(DURABILITY).sort()).toEqual([
      "aiCache",
      "assets",
      "bookmarks",
      "documents",
      "explanations",
      "marks",
      "occurrences",
      "progress",
      "reviewCards",
      "reviewEvents",
      "semanticPages",
      "settings",
      "vocabulary",
    ]);
  });
});
