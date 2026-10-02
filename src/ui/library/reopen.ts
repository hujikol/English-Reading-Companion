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
