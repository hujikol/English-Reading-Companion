/**
 * Progress and bookmark behaviour as the reader drives it: the debounce rule
 * from Section 13 and the save/announce rules from Section 4, both exercised
 * through the real pure modules with a fake store.
 *
 * The Dexie-backed store lives in `src/ui/reader/stores.ts` and is not imported
 * here: IndexedDB does not exist in the test environment, so these tests prove
 * the POLICY the reader applies, not IndexedDB itself.
 */

import { describe, expect, it, vi } from "vitest";
import { MOVEMENT_DEBOUNCE_MS, bumpRevision, initialProgressState, isSavedLocally, mustFlushNow, pageOf, persistProgress, queueProgress, samePosition, type ProgressRow, type ProgressStore } from "../../../src/features/library/progress.ts";
import { ProgressConflictError } from "../../../src/features/library/progress.ts";
import { announce, hasBookmarkAt, isSamePosition, makeBookmark, renameBookmark, saveBookmark, softDelete, visibleBookmarks } from "../../../src/features/library/bookmarks.ts";
import { locatorAt } from "../../../src/ui/reader/readerModel.ts";

const fakeStore = (): ProgressStore & { rows: Map<string, ProgressRow>; writes: number } => {
  const rows = new Map<string, ProgressRow>();
  return {
    rows,
    writes: 0,
    async read(documentId) {
      return rows.get(documentId);
    },
    async write(row, expectedRevision) {
      const current = rows.get(row.documentId)?.revision ?? 0;
      if (current !== expectedRevision) throw new ProgressConflictError(current);
      rows.set(row.documentId, row);
      this.writes++;
    },
  };
};

const doc = "doc_1";

describe("progress writes are debounced, flushed, and honest", () => {
  it("uses a one second movement debounce", () => {
    expect(MOVEMENT_DEBOUNCE_MS).toBe(1000);
  });

  it("must flush on a page change, a visibility change and a close", () => {
    const before = locatorAt(1, 0.1);
    const after = locatorAt(2, 0.1);
    expect(mustFlushNow(before, after, "move")).toBe(true); // page boundary
    expect(mustFlushNow(before, after, "visibility-change")).toBe(true);
    expect(mustFlushNow(before, after, "close")).toBe(true);
  });

  it("debounces a move inside one page", () => {
    expect(mustFlushNow(locatorAt(1, 0.1), locatorAt(1, 0.4), "move")).toBe(false);
  });

  it("never reports Saved while a write is outstanding", async () => {
    const store = fakeStore();
    let state = initialProgressState(doc);
    state = queueProgress(state, locatorAt(1, 0.5), 0.2);
    expect(state.pending).toBeDefined();
    expect(isSavedLocally(state)).toBe(false);

    const { state: after, outcome } = await persistProgress(state, { locator: locatorAt(1, 0.5), progression: 0.2 }, store, 1000);
    expect(outcome.kind).toBe("saved");
    expect(isSavedLocally(after)).toBe(true);
    expect(after.lastOutcome?.kind).toBe("saved");
  });

  it("bumps the revision so a stale tab is refused, not silently merged", async () => {
    const store = fakeStore();
    const first = await persistProgress(initialProgressState(doc), { locator: locatorAt(1, 0), progression: 0.1 }, store, 1);
    expect(first.state.revision).toBe(bumpRevision(0));

    // a second tab writes from the same starting revision
    const stale = await persistProgress(initialProgressState(doc), { locator: locatorAt(9, 0), progression: 0.9 }, store, 2);
    expect(stale.outcome.kind).toBe("conflict");
    // the durable position is still the newer one, not the stale one
    expect(store.rows.get(doc)?.locator).toMatchObject({ pageIndex: 1 });
  });

  it("reports a failed write as failed and keeps the previous durable position", async () => {
    const store: ProgressStore = {
      read: async () => undefined,
      write: async () => {
        throw new Error("quota exceeded");
      },
    };
    const { state, outcome } = await persistProgress(initialProgressState(doc), { locator: locatorAt(3, 0), progression: 0.3 }, store, 5);
    expect(outcome.kind).toBe("failed");
    expect(state.lastWritten).toBeUndefined();
    expect(isSavedLocally(state)).toBe(false);
  });

  it("treats a different pageFraction as a different position", () => {
    expect(samePosition(locatorAt(1, 0.2), locatorAt(1, 0.8))).toBe(false);
    expect(samePosition(locatorAt(1, 0.2), locatorAt(1, 0.2))).toBe(true);
  });

  it("knows which page a locator points at, for the page-change flush", () => {
    expect(pageOf(locatorAt(7, 0))).toBe(7);
    expect(pageOf({ kind: "text", blockId: "b", start: 0, end: 1 })).toBeUndefined();
  });
});

describe("bookmarks are positions plus a label", () => {
  const bookmark = (page: number, fraction: number, now: number) =>
    makeBookmark({ documentId: doc, titleSnapshot: "Book", locator: locatorAt(page, fraction), now, crypto });

  it("captures the page and the scroll fraction", () => {
    const b = bookmark(4, 0.375, 1);
    expect(b.locator).toEqual(locatorAt(4, 0.375));
    expect(JSON.stringify(b)).not.toMatch(/bbox|rect|coord|width|height/i);
  });

  it("labels by page until verified headings exist", () => {
    expect(bookmark(4, 0, 1).label).toBe("Page 5");
  });

  it("lets two bookmarks coexist on one page, distinguished by fraction", () => {
    const list = [bookmark(4, 0.1, 1), bookmark(4, 0.9, 2)];
    expect(visibleBookmarks(list)).toHaveLength(2);
    expect(hasBookmarkAt(list, locatorAt(4, 0.1))).toBe(true);
    expect(hasBookmarkAt(list, locatorAt(4, 0.5))).toBe(false);
  });

  it("reports pressed only at the exact position, and ignores a deleted one", () => {
    const list = [softDelete(bookmark(4, 0.1, 1), 5)];
    expect(hasBookmarkAt(list, locatorAt(4, 0.1))).toBe(false);
  });

  it("renames without moving the position", () => {
    const b = bookmark(3, 0.4, 1);
    const renamed = renameBookmark(b, "  Chapter 3  ", 9);
    expect(renamed.label).toBe("Chapter 3");
    expect(renamed.locator).toEqual(b.locator);
  });

  it("soft deletes, so the row survives for undo", () => {
    const gone = softDelete(bookmark(2, 0, 1), 5);
    expect(gone.deletedAt).toBe(5);
    expect(visibleBookmarks([gone])).toHaveLength(0);
  });

  it("announces a successful save with the label", async () => {
    const outcome = await saveBookmark(bookmark(1, 0, 1), async () => undefined);
    expect(outcome.kind).toBe("saved");
    expect(announce(outcome)).toBe("Bookmark added: Page 2");
  });

  it("announces a failed save and does not claim it worked", async () => {
    const draft = bookmark(1, 0, 1);
    const outcome = await saveBookmark(draft, async () => {
      throw new Error("storage full");
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(announce(outcome)).toContain("Still unsaved");
    // the caller keeps the label to retry with
    expect(outcome.draft.label).toBe("Page 2");
  });

  it("does not write when the write rejects, and surfaces the reason once", async () => {
    const write = vi.fn(async () => {
      throw new Error("quota");
    });
    const outcome = await saveBookmark(bookmark(1, 0, 1), write);
    expect(write).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("failed");
  });

  it("agrees with the reader's own position comparison", () => {
    const b = bookmark(6, 0.25, 1);
    expect(isSamePosition(b.locator, locatorAt(6, 0.25))).toBe(true);
    expect(isSamePosition(b.locator, locatorAt(6, 0.26))).toBe(false);
  });
});
