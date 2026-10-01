/**
 * Bookmarks: a named position. Section 4. A label is not part of a position, so
 * rename and reorder never touch the locator. Any number of bookmarks may exist
 * on one page — pageFraction distinguishes them, so dedup by page is forbidden.
 *
 * Pure functions plus an injected writer. A failed write returns the draft
 * unchanged and marked unsaved, so the caller keeps the label and can retry.
 */

import type { Bookmark, Locator } from "../../contracts/index.ts";
import { newBookmarkId } from "./identity.ts";

export type BookmarkWrite = (b: Bookmark) => Promise<void>;

/** On failure the caller keeps the bookmark it tried to write and offers retry. */
export type BookmarkOutcome = { kind: "saved"; bookmark: Bookmark } | { kind: "failed"; message: string; draft: Bookmark };

/** The visible-but-not-durable state. Rendered as unsaved with an inline retry. */
export type BookmarkDraft = {
  bookmark: Bookmark;
  label: string;
  saved: boolean;
  error?: string;
};

const active = (b: Bookmark): boolean => b.deletedAt === undefined;

/** Capture the current visible position. pageFraction keeps a reopened bookmark on the same line. */
export function makeBookmark(input: {
  documentId: string;
  titleSnapshot: string;
  locator: Locator;
  label?: string;
  now?: number;
  id?: string;
  crypto?: Crypto;
}): Bookmark {
  const now = input.now ?? Date.now();
  return {
    id: input.id ?? newBookmarkId(input.crypto ?? globalThis.crypto),
    documentId: input.documentId,
    titleSnapshot: input.titleSnapshot,
    locator: input.locator,
    // Section 4: labels use page position until verified headings are available.
    label: input.label ?? defaultLabel(input.locator),
    createdAt: now,
    updatedAt: now,
  };
}

export const defaultLabel = (l: Locator): string =>
  l.kind === "pdf" ? `Page ${l.pageIndex + 1}` : l.kind === "epub" ? l.spineHref : `Block ${l.blockId}`;

/** Rename changes `label` and `updatedAt` only. Deep-equal on the locator is the test. */
export function renameBookmark(b: Bookmark, label: string, now: number = Date.now()): Bookmark {
  const trimmed = label.trim();
  return { ...b, label: trimmed === "" ? defaultLabel(b.locator) : trimmed, updatedAt: now };
}

/** Soft delete; `deletedAt` is what the list filters on. Immediate, undoable, no dialog. */
export const softDelete = (b: Bookmark, now: number = Date.now()): Bookmark => ({ ...b, deletedAt: now, updatedAt: now });

/** Undo within the session restores the exact row that was deleted. */
export const restore = (b: Bookmark): Bookmark => {
  const { deletedAt: _gone, ...rest } = b;
  return { ...rest, updatedAt: Date.now() };
};

/** Newest first is the library's stable order; reorder never renumbers a page. */
export const visibleBookmarks = (all: readonly Bookmark[]): Bookmark[] =>
  all.filter(active).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));

/**
 * Explicit user order. `ids` is the complete new order; omitted ids are appended
 * in their existing order, so a partial drop cannot silently drop a bookmark.
 */
export function reorderBookmarks(all: readonly Bookmark[], ids: readonly string[]): Bookmark[] {
  const byId = new Map(all.map((b) => [b.id, b]));
  const ordered: Bookmark[] = [];
  const used = new Set<string>();
  for (const id of ids) {
    const b = byId.get(id);
    if (b !== undefined && !used.has(id)) {
      ordered.push(b);
      used.add(id);
    }
  }
  for (const b of visibleBookmarks(all)) if (!used.has(b.id)) ordered.push(b);
  return ordered.filter(active);
}

/** Two bookmarks on one page coexist; a different pageFraction is a different position. */
export const isSamePosition = (a: Locator, b: Locator): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "pdf" && b.kind === "pdf") return a.pageIndex === b.pageIndex && a.pageFraction === b.pageFraction;
  if (a.kind === "epub" && b.kind === "epub") return a.spineHref === b.spineHref && a.cfi === b.cfi;
  return a.kind === "text" && b.kind === "text" && a.blockId === b.blockId && a.start === b.start;
};

/**
 * The page control's pressed state. Exact position, so pressing the button
 * again on the same line must not create a duplicate row.
 */
export const hasBookmarkAt = (all: readonly Bookmark[], locator: Locator): boolean =>
  all.some((b) => active(b) && isSamePosition(b.locator, locator));

/** Section 4: renaming must not rewrite the locator, so label equality is never position equality. */
export const labelOnly = (a: Bookmark, b: Bookmark): boolean =>
  a.id === b.id && a.label === b.label && JSON.stringify(a.locator) === JSON.stringify(b.locator);

/** Write then confirm. A rejection keeps the draft unsaved and editable; it never reads Saved. */
export async function saveBookmark(draft: Bookmark, write: BookmarkWrite): Promise<BookmarkOutcome> {
  try {
    await write(draft);
    return { kind: "saved", bookmark: draft };
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : "Bookmark could not be saved.", draft };
  }
}

/** Inline label editing: update the draft, keep it unsaved until the write resolves. */
export function editDraft(d: BookmarkDraft, label: string): BookmarkDraft {
  // rebuilt, not spread: exactOptionalPropertyTypes forbids `error: undefined`
  const next = renameBookmark(d.bookmark, label);
  return { bookmark: next, label: next.label, saved: false };
}

/** Live-region text. Programmatic confirmation, because a visual badge is not announced. */
export const announce = (o: BookmarkOutcome): string =>
  o.kind === "saved" ? `Bookmark added: ${o.bookmark.label}` : `Bookmark could not be saved: ${o.message}. Still unsaved.`;
