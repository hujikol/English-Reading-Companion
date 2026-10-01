import { describe, expect, it } from "vitest";
import { bumpGeneration, handleResponses, isCurrent, openGuard } from "../../src/document/generation.ts";

describe("generation guard", () => {
  it("starts at 1 and ignores nothing yet", () => {
    const guard = openGuard("doc_1");
    expect(guard.current).toBe(1);
    expect(isCurrent(guard, { documentId: "doc_1", generation: 1 })).toBe(true);
  });

  it("increments on close/reopen", () => {
    expect(bumpGeneration(bumpGeneration(openGuard("doc_1"))).current).toBe(3);
  });

  it("ignores a response from an older generation", () => {
    const guard = bumpGeneration(openGuard("doc_1"));
    expect(isCurrent(guard, { documentId: "doc_1", generation: 1 })).toBe(false);
  });

  it("ignores a response for a different document", () => {
    const guard = openGuard("doc_1");
    expect(isCurrent(guard, { documentId: "doc_2", generation: 9 })).toBe(false);
  });

  it("refuses an out-of-order arrival without disturbing the current generation", () => {
    const before = bumpGeneration(openGuard("doc_1"));
    const responses = [
      { requestId: "r2", documentId: "doc_1", generation: 1 }, // late, from the old session
      { requestId: "r3", documentId: "doc_1", generation: 2 }, // current
      { requestId: "r4", documentId: "doc_2", generation: 2 }, // other document
      { requestId: "r5", documentId: "doc_1", generation: 3 }, // newer session
    ];
    const { guard, events } = handleResponses(before, responses);
    expect(guard.current).toBe(2);
    expect(events.map((e) => e.accepted)).toEqual([false, true, false, true]);
    expect(events.map((e) => e.reason)).toEqual(["stale-generation", "current", "foreign-document", "current"]);
  });

  it("keeps two open documents independent", () => {
    const a = openGuard("doc_1");
    const b = bumpGeneration(openGuard("doc_2"));
    expect(isCurrent(a, { documentId: "doc_1", generation: 1 })).toBe(true);
    expect(isCurrent(b, { documentId: "doc_2", generation: 2 })).toBe(true);
    expect(isCurrent(a, { documentId: "doc_1", generation: 2 })).toBe(true);
  });
});
