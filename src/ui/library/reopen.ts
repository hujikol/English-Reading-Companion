/**
 * Reopening a saved document from the library.
 *
 * The gap this closes: importing a book and reopening it were separate paths.
 * A freshly imported document has no progress row, so re-opening it started at
 * page 1 and the learner lost their place with no way back. Progress restore
 * worked — it was just unreachable, because nothing ever handed the reader a
 * stored document.
 *
 * The original bytes live in the `assets` table, so reopening needs no File
 * picker and no re-import: the reader gets the same blob it would have read
 * from disk.
 *
 * Listing rows, position labels and storage labels already live in
 * `libraryModel.ts`; this module only covers what was missing — turning a stored
 * document back into something the reader can open.
 */

import { db } from "../../db/index.ts";
import type { DocumentRecord } from "../../db/index.ts";

export type ReopenResult =
  | { ok: true; document: DocumentRecord; file: File }
  | { ok: false; reason: "not-found" | "no-stored-bytes"; documentId: string };

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
};

export const mimeFor = (originalName: string): string => {
  const ext = originalName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
};

/**
 * Load a stored document as a File the reader can open directly.
 *
 * Refuses when the bytes are gone rather than opening an empty document: a
 * silent empty read would look like a corrupt PDF instead of a missing asset.
 */
export async function reopenDocument(documentId: string): Promise<ReopenResult> {
  const document = await db.documents.get(documentId);
  if (document === undefined) return { ok: false, reason: "not-found", documentId };

  const asset = await db.assets.get(documentId);
  if (asset === undefined || asset.blob === undefined || asset.blob.size === 0) {
    return { ok: false, reason: "no-stored-bytes", documentId };
  }

  const file = new File([asset.blob], document.originalName, {
    type: mimeFor(document.originalName),
  });
  return { ok: true, document, file };
}

/** Repair old duplicate imports without orphaning learning data or losing the latest position. */
export async function repairLibrary(): Promise<void> {
  await db.transaction("rw", [db.documents, db.assets, db.progress, db.marks, db.bookmarks, db.occurrences, db.semanticPages], async () => {
    const documents = await db.documents.toArray();
    const groups = new Map<string, DocumentRecord[]>();
    for (const row of documents) {
      const asset = await db.assets.get(row.id);
      if (asset?.blob?.size && row.importState !== "ready") await db.documents.update(row.id, { importState: "ready" });
      if (!row.contentHash || !asset?.blob?.size) continue;
      const group = groups.get(row.contentHash) ?? [];
      group.push(row); groups.set(row.contentHash, group);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const survivor = group.sort((a, b) => a.importedAt - b.importedAt)[0]!;
      const positions = (await db.progress.bulkGet(group.map(d => d.id))).filter(p => p !== undefined).sort((a, b) => b.updatedAt - a.updatedAt);
      const latest = positions[0];
      if (latest) {
        // Raise the survivor revision so already-open tabs cannot overwrite the repaired position.
        await db.progress.put({ ...latest, documentId: survivor.id, revision: Math.max(...positions.map(p => p.revision)) + 1 });
      }
      await db.documents.update(survivor.id, { lastOpenedAt: Math.max(...group.map(d => d.lastOpenedAt)) });
      for (const duplicate of group.slice(1)) {
        await db.marks.where("documentId").equals(duplicate.id).modify({ documentId: survivor.id });
        await db.bookmarks.where("documentId").equals(duplicate.id).modify({ documentId: survivor.id });
        await db.occurrences.where("documentId").equals(duplicate.id).modify({ documentId: survivor.id });
        await db.semanticPages.where("documentId").equals(duplicate.id).delete();
        await db.progress.delete(duplicate.id); await db.assets.delete(duplicate.id); await db.documents.delete(duplicate.id);
      }
    }
  });
}
