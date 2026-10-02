/**
 * Dexie-backed stores for the reader. Every write goes through the pure module
 * that owns the policy (progress.ts, bookmarks.ts, marks/save.ts) and this file
 * only supplies the persistence surface those modules expect as an injected
 * writer. No policy is duplicated here.
 */

import type { Bookmark, Mark } from "../../contracts/index.ts";
import { db } from "../../db/index.ts";
import { saveMark, type SaveMarkInputLike } from "../../features/marks/save.ts";
import { liveMarks } from "../../features/marks/service.ts";
import { ProgressConflictError, type ProgressRow } from "../../features/library/progress.ts";

/**
 * Section 13: a stale tab must not overwrite a newer location, so `write`
 * refuses when the stored revision is not the one this tab read.
 */
export const dbProgressStore = {
  async read(documentId: string): Promise<ProgressRow | undefined> {
    const row = await db.progress.get(documentId);
    return row === undefined ? undefined : { ...row };
  },

  async write(row: ProgressRow, expectedRevision: number): Promise<void> {
    await db.transaction("rw", db.progress, async () => {
      const current = await db.progress.get(row.documentId);
      const storedRevision = current?.revision ?? 0;
      if (storedRevision !== expectedRevision) throw new ProgressConflictError(storedRevision);
      await db.progress.put(row);
    });
  },
};

/** Persist a bookmark row. Soft deletes are rows too, so this never filters. */
export const writeBookmark = async (bookmark: Bookmark): Promise<void> => {
  await db.bookmarks.put(bookmark);
};

export const readBookmarks = async (documentId: string): Promise<Bookmark[]> =>
  (await db.bookmarks.where("documentId").equals(documentId).toArray()).filter((b) => b.deletedAt === undefined);

export const readMarks = async (documentId: string): Promise<Mark[]> => liveMarks(await db.marks.where("documentId").equals(documentId).toArray(), documentId);

/**
 * Build and store a mark in one step. `saveMark` validates the locator and
 * always returns `anchorState: "unresolved"` — nothing has re-found the text
 * yet, so the row must not claim otherwise.
 */
export async function storeMark(input: SaveMarkInputLike): Promise<Mark | undefined> {
  const result = saveMark(input);
  if (!result.ok) return undefined;
  await db.marks.put(result.mark);
  return result.mark;
}

export const newMarkId = (): string => `mk_${crypto.randomUUID().replace(/-/g, "")}`;

/** Records the durable document identity for a file the user just opened. */
export async function recordDocument(record: {
  id: string;
  title: string;
  originalName: string;
  byteSize: number;
  pageCount?: number;
  contentHash?: string;
  asset?: { documentId: string; blob: Blob; mime: string; byteSize: number; checksum: string };
  now?: number;
}): Promise<void> {
  const now = record.now ?? Date.now();
  await db.transaction("rw", [db.documents, db.assets], async () => {
    await db.documents.put({
      id: record.id,
      title: record.title,
      originalName: record.originalName,
      format: "pdf",
      byteSize: record.byteSize,
      importedAt: now,
      lastOpenedAt: now,
      importState: "ready",
      ...(record.contentHash === undefined ? {} : { contentHash: record.contentHash }),
      ...(record.pageCount === undefined ? {} : { pageCount: record.pageCount }),
    });
    if (record.asset !== undefined) await db.assets.put(record.asset);
  });
}

export const touchDocument = async (documentId: string, now: number = Date.now()): Promise<void> => {
  await db.documents.update(documentId, { lastOpenedAt: now });
};

export const readDocument = (documentId: string) => db.documents.get(documentId);

export const readAsset = (documentId: string) => db.assets.get(documentId);
