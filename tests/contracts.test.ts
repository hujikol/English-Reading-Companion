import { describe, expect, it } from "vitest";
import type { Anchor, Locator } from "../src/contracts/index.ts";

const loc = (): Locator => ({ kind: "pdf", pageIndex: 3, pageFraction: 0.25 });
const anchor = (over: Partial<Anchor> = {}): Anchor => ({ quote: "leverage", locator: loc(), anchorState: "resolved", ...over });

describe("Anchor", () => {
  it("stores no geometry", () => {
    const a: unknown = anchor();
    expect(JSON.stringify(a)).not.toMatch(/bbox|coord|rect/i);
  });

  it("carries quote-based disambiguation for re-anchoring", () => {
    const a = anchor({ prefix: "the", suffix: "of the firm" });
    expect(a.prefix).toBe("the");
    expect(a.suffix).toBe("of the firm");
  });

  it("tracks lost anchors instead of silently dropping them", () => {
    expect(anchor({ anchorState: "lost" }).anchorState).toBe("lost");
  });
});

describe("Locator", () => {
  it("keeps pageFraction as a scroll offset, not a box", () => {
    const l = loc();
    expect(l).toEqual({ kind: "pdf", pageIndex: 3, pageFraction: 0.25 });
    expect(Object.keys(l)).not.toContain("bbox");
  });
});
