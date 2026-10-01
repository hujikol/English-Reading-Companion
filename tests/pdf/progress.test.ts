import { describe, expect, it } from "vitest";
import {
  bumpRevision,
  initialProgressState,
  isSavedLocally,
  mustFlushNow,
  pageOf,
  persistProgress,
  ProgressConflictError,
  queueProgress,
  samePosition,
  type ProgressRow,
  type ProgressStore,
} from "../../src/features/library/progress.ts";
import type { Locator } from "../../src/contracts/index.ts";

const at = (page: number, frac = 0): Locator => ({ kind: "pdf", pageIndex: page, pageFraction: frac });

/** In-memory store with the real revision guard, so conflicts are not mocked away. */
function fakeStore(): ProgressStore & { rows: Map<string, ProgressRow>; writes: number } {
  const rows = new Map<string, ProgressRow>();
  const s = {
    rows,
    writes: 0,
    async read(id: string) {
      return rows.get(id);
    },
    async write(row: ProgressRow, expected: number) {
      const cur = rows.get(row.documentId);
      if ((cur?.revision ?? 0) > expected) throw new ProgressConflictError(cur?.revision ?? 0);
      s.writes++;
      rows.set(row.documentId, row);
    },
  };
  return s;
}

describe("progress writes", () => {
  it("records success before any Saved state is derivable", async () => {
    const store = fakeStore();
    let state = initialProgressState("d1");
    expect(isSavedLocally(state)).toBe(false);
    const r = await persistProgress(state, { locator: at(2, 0.5), progression: 0.2 }, store, 1000);
    state = r.state;
    expect(r.outcome.kind).toBe("saved");
    expect(isSavedLocally(state)).toBe(true);
    expect(store.rows.get("d1")?.locator).toEqual(at(2, 0.5));
  });

  it("does not report Saved after a failed write, and keeps the old position", async () => {
    const good = fakeStore();
    let state = (await persistProgress(initialProgressState("d1"), { locator: at(1, 0), progression: 0.1 }, good, 1)).state;
    // storage now refuses: quota is gone, but page 1 is genuinely durable
    const store: ProgressStore = { read: () => good.read("d1"), write: async () => { throw new Error("QuotaExceededError"); } };
    const r = await persistProgress(state, { locator: at(2, 0), progression: 0.2 }, store, 2);
    expect(r.outcome).toEqual({ kind: "failed", message: "QuotaExceededError" });
    expect(isSavedLocally(r.state)).toBe(false);
    expect(r.state.lastWritten).toEqual(at(1, 0));
  });

  it("treats a non-Error rejection as failed, not thrown", async () => {
    const store: ProgressStore = { read: async () => undefined, write: async () => Promise.reject("nope") };
    const r = await persistProgress(initialProgressState("d1"), { locator: at(0), progression: 0 }, store);
    expect(r.outcome.kind).toBe("failed");
  });

  it("clamps progression into 0..1", async () => {
    const store = fakeStore();
    const r = await persistProgress(initialProgressState("d1"), { locator: at(0), progression: 4 }, store);
    if (r.outcome.kind !== "saved") throw new Error("expected saved");
    expect(r.outcome.record.progression).toBe(1);
  });

  it("refuses a stale tab and reports the conflict instead of overwriting", async () => {
    const store = fakeStore();
    const tabA = (await persistProgress(initialProgressState("d1"), { locator: at(1, 0), progression: 0.1 }, store, 1)).state;
    // tab B writes twice behind tab A's back
    const b1 = (await persistProgress(initialProgressState("d1"), { locator: at(5, 0), progression: 0.5 }, store, 2)).state;
    await persistProgress(b1, { locator: at(9, 0), progression: 0.9 }, store, 3);

    const r = await persistProgress(tabA, { locator: at(2, 0), progression: 0.2 }, store, 4);
    expect(r.outcome).toEqual({ kind: "conflict", currentRevision: 2 });
    expect(store.rows.get("d1")?.locator).toEqual(at(9, 0)); // newer location survives
  });

  it("increments the revision by exactly one per write", async () => {
    expect(bumpRevision(0)).toBe(1);
    const store = fakeStore();
    let s = initialProgressState("d1");
    s = (await persistProgress(s, { locator: at(0), progression: 0 }, store)).state;
    s = (await persistProgress(s, { locator: at(1), progression: 0.1 }, store)).state;
    expect(store.rows.get("d1")?.revision).toBe(2);
    expect(s.revision).toBe(2);
  });

  it("restores a saved revision rather than starting at zero", () => {
    const restored: ProgressRow = { documentId: "d1", locator: at(3, 0.2), progression: 0.3, updatedAt: 9, revision: 7 };
    const s = initialProgressState("d1", restored);
    expect(s.revision).toBe(7);
    expect(s.lastWritten).toEqual(at(3, 0.2));
  });
});

describe("debounce and flush decisions", () => {
  it("holds a pending write during movement and clears it on save", async () => {
    const store = fakeStore();
    const queued = queueProgress(initialProgressState("d1"), at(1, 0.1), 0.05);
    expect(isSavedLocally(queued)).toBe(false);
    const saved = (await persistProgress(queued, queued.pending!, store)).state;
    expect(saved.pending).toBeUndefined();
    expect(isSavedLocally(saved)).toBe(true);
  });

  it("coalesces repeated movement to the newest position", () => {
    let s = queueProgress(initialProgressState("d1"), at(1, 0.1), 0.1);
    s = queueProgress(s, at(1, 0.4), 0.4);
    s = queueProgress(s, at(1, 0.9), 0.9);
    expect(s.pending).toEqual({ locator: at(1, 0.9), progression: 0.9 });
  });

  it("flushes immediately on page change, visibility change, close and first position", () => {
    expect(mustFlushNow(at(1, 0.9), at(1, 0.95), "move")).toBe(false);
    expect(mustFlushNow(at(1, 0.9), at(2, 0), "move")).toBe(true);
    expect(mustFlushNow(undefined, at(0, 0), "move")).toBe(true);
    expect(mustFlushNow(at(1), at(1), "page-change")).toBe(true);
    expect(mustFlushNow(at(1), at(1), "visibility-change")).toBe(true);
    expect(mustFlushNow(at(1), at(1), "close")).toBe(true);
  });

  it("treats a format change as a boundary", () => {
    expect(mustFlushNow(at(1), { kind: "text", blockId: "b", start: 0, end: 1 }, "move")).toBe(true);
  });
});

describe("position comparison", () => {
  it("reads the page from a pdf locator only", () => {
    expect(pageOf(at(4, 0.5))).toBe(4);
    expect(pageOf({ kind: "text", blockId: "b", start: 0, end: 1 })).toBeUndefined();
  });

  it("treats two fractions on one page as different positions", () => {
    expect(samePosition(at(3, 0.2), at(3, 0.8))).toBe(false);
    expect(samePosition(at(3, 0.2), at(3, 0.2))).toBe(true);
  });

  it("does not call a missing position equal to a present one", () => {
    expect(samePosition(undefined, at(0))).toBe(false);
    expect(samePosition(undefined, undefined)).toBe(true);
  });
});