import { describe, expect, it } from "vitest";
import type { Bookmark, Locator } from "../../src/contracts/index.ts";
import {
  announce,
  defaultLabel,
  editDraft,
  hasBookmarkAt,
  isSamePosition,
  labelOnly,
  makeBookmark,
  reorderBookmarks,
  renameBookmark,
  restore,
  saveBookmark,
  softDelete,
  visibleBookmarks,
  type BookmarkDraft,
} from "../../src/features/library/bookmarks.ts";

const crypto = globalThis.crypto;
const at = (page: number, frac = 0): Locator => ({ kind: "pdf", pageIndex: page, pageFraction: frac });

const bm = (page: number, frac: number, now: number, label?: string): Bookmark =>
  makeBookmark({ documentId: "d1", titleSnapshot: "Book", locator: at(page, frac), now, crypto, ...(label === undefined ? {} : { label }) });

describe("bookmark capture", () => {
  it("captures page and pageFraction so reopening lands on the same line", () => {
    const b = bm(4, 0.375, 100);
    expect(b.locator).toEqual(at(4, 0.375));
  });

  it("labels by page position until verified headings exist", () => {
    expect(defaultLabel(at(4))).toBe("Page 5");
    expect(bm(0, 0, 1).label).toBe("Page 1");
    expect(defaultLabel({ kind: "text", blockId: "b7", start: 0, end: 1 })).toBe("Block b7");
    expect(defaultLabel({ kind: "epub", spineHref: "ch2.xhtml" })).toBe("ch2.xhtml");
  });

  it("never stores geometry", () => {
    expect(JSON.stringify(bm(1, 0.5, 1))).not.toMatch(/bbox|rect|coord|top|left|width|height/i);
  });
});

describe("many bookmarks on one page coexist", () => {
  it("does not dedup by page", () => {
    const a = bm(4, 0.1, 1);
    const b = bm(4, 0.9, 2);
    expect(a.locator).toMatchObject({ kind: "pdf", pageIndex: 4 });
    expect(b.locator).toMatchObject({ kind: "pdf", pageIndex: 4 });
    expect(isSamePosition(a.locator, b.locator)).toBe(false);
    expect(visibleBookmarks([a, b])).toHaveLength(2);
  });

  it("reports the button as pressed only for the exact position", () => {
    const list = [bm(4, 0.1, 1), bm(4, 0.9, 2)];
    expect(hasBookmarkAt(list, at(4, 0.1))).toBe(true);
    expect(hasBookmarkAt(list, at(4, 0.5))).toBe(false);
    expect(hasBookmarkAt(list, at(5, 0.1))).toBe(false);
  });

  it("ignores a deleted bookmark at the same position", () => {
    const gone = softDelete(bm(4, 0.1, 1), 5);
    expect(hasBookmarkAt([gone], at(4, 0.1))).toBe(false);
  });
});

describe("rename does not move the position", () => {
  it("changes only label and updatedAt", () => {
    const b = bm(3, 0.4, 10, "Old");
    const r = renameBookmark(b, "  Chapter 3  ", 99);
    expect(r.label).toBe("Chapter 3");
    expect(r.updatedAt).toBe(99);
    expect(r.locator).toEqual(b.locator); // the locator is untouched
    expect(r.id).toBe(b.id);
    expect(labelOnly(b, r)).toBe(false); // labels differ, so they are not the same row
  });

  it("falls back to the page label when the rename is emptied", () => {
    expect(renameBookmark(bm(3, 0.4, 10, "Old"), "   ", 99).label).toBe("Page 4");
  });

  it("treats two different labels on one position as the same position", () => {
    const a = bm(3, 0.4, 10, "A");
    const b = bm(3, 0.4, 10, "B");
    expect(a.id).not.toBe(b.id);
    expect(isSamePosition(a.locator, b.locator)).toBe(true);
  });
});

describe("delete and undo", () => {
  it("soft deletes, then restores the exact row", () => {
    const b = bm(2, 0.2, 10, "Keep");
    const d = softDelete(b, 50);
    expect(d.deletedAt).toBe(50);
    expect(visibleBookmarks([b, d])).toHaveLength(1);
    const back = restore(d);
    expect(back.deletedAt).toBeUndefined();
    expect(back.label).toBe("Keep");
    expect(back.locator).toEqual(b.locator);
  });

  it("hides deleted rows from the list but keeps them in the store", () => {
    const a = bm(1, 0, 1);
    const b = softDelete(bm(1, 0.5, 2), 3);
    expect(visibleBookmarks([a, b]).map((x: Bookmark) => x.id)).toEqual([a.id]);
  });
});

describe("reorder", () => {
  const list = [bm(1, 0.1, 30), bm(2, 0.1, 20), bm(3, 0.1, 10)];

  it("follows the requested order exactly", () => {
    const r = reorderBookmarks(list, [list[2]!.id, list[0]!.id, list[1]!.id]);
    expect(r.map((b: Bookmark) => b.id)).toEqual([list[2]!.id, list[0]!.id, list[1]!.id]);
  });

  it("appends omitted ids instead of dropping them", () => {
    const r = reorderBookmarks(list, [list[1]!.id]);
    expect(r).toHaveLength(3);
    expect(r[0]!.id).toBe(list[1]!.id);
  });

  it("ignores unknown ids and skips soft-deleted rows", () => {
    const withGone = [...list, softDelete(bm(9, 0, 1), 99)];
    const r = reorderBookmarks(withGone, ["nope", list[0]!.id]);
    expect(r).toHaveLength(3);
  });

  it("does not rewrite any locator", () => {
    const before = JSON.stringify(list.map((b) => b.locator));
    reorderBookmarks(list, [list[1]!.id, list[0]!.id, list[2]!.id]);
    expect(JSON.stringify(list.map((b) => b.locator))).toBe(before);
  });
});

describe("failed writes stay unsaved and editable", () => {
  const b = bm(5, 0.25, 10, "Draft");

  it("reports failure and returns the draft for retry", async () => {
    const o = await saveBookmark(b, async () => Promise.reject(new Error("disk full")));
    expect(o.kind).toBe("failed");
    if (o.kind !== "failed") throw new Error("unreachable");
    expect(o.message).toBe("disk full");
    expect(o.draft.label).toBe("Draft");
    expect(o.draft.locator).toEqual(b.locator);
  });

  it("keeps an edited draft unsaved until a later write resolves", async () => {
    const draft: BookmarkDraft = { bookmark: b, label: b.label, saved: false };
    const edited = editDraft(draft, "My chapter");
    expect(edited.label).toBe("My chapter");
    expect(edited.saved).toBe(false);
    const o = await saveBookmark(edited.bookmark, async () => {});
    expect(o.kind).toBe("saved");
    if (o.kind !== "saved") throw new Error("unreachable");
    expect(o.bookmark.locator).toEqual(b.locator);
  });

  it("clears a previous error after a successful edit", async () => {
    const failed = await saveBookmark(b, async () => Promise.reject(new Error("x")));
    if (failed.kind !== "failed") throw new Error("unreachable");
    const draft: BookmarkDraft = { bookmark: failed.draft, label: failed.draft.label, saved: false, error: failed.message };
    const edited = editDraft(draft, "Retry");
    expect(edited.error).toBeUndefined();
    expect(edited.saved).toBe(false);
  });

  it("announces add, remove and failure for a live region", async () => {
    const saved = await saveBookmark(b, async () => {});
    expect(announce(saved)).toBe("Bookmark added: Draft");
    const bad = await saveBookmark(b, async () => Promise.reject(new Error("quota")));
    expect(announce(bad)).toMatch(/could not be saved.*quota/);
    expect(announce(bad)).toMatch(/unsaved/i);
  });

  it("never reports Saved when the write rejected", async () => {
    const o = await saveBookmark(b, async () => Promise.reject(new Error("nope")));
    expect("saved" in o && o.saved).toBeFalsy();
  });
});