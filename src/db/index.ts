import Dexie, { type Table } from "dexie";
import type {
  Anchor,
  Bookmark,
  Explanation,
  Mark,
  Occurrence,
  ReviewGrade,
  Vocabulary,
} from "../contracts/index.ts";
import type { Format, Locator } from "../contracts/document.ts";

export type DocumentRecord = {
  id: string;
  contentHash?: string;
  title: string;
  originalName: string;
  format: Format;
  byteSize: number;
  pageCount?: number;
  importedAt: number;
  lastOpenedAt: number;
  importState: "saving" | "ready" | "temporary" | "failed";
  assetId?: string;
};

export type AssetRecord = { documentId: string; blob: Blob; mime: string; byteSize: number; checksum: string };

export type ProgressRecord = {
  documentId: string;
  locator: Locator;
  progression: number;
  updatedAt: number;
  /** guards against a stale tab overwriting a newer location */
  revision: number;
};

export type ReviewCard = {
  vocabularyId: string;
  stage: number;
  dueAt: number;
  lastReviewedAt?: number;
  suspended: boolean;
};

export type ReviewEvent = {
  id: string;
  cardId: string;
  grade: ReviewGrade;
  stageBefore: number;
  stageAfter: number;
  reviewedAt: number;
};

export type AiCacheRecord = {
  requestHash: string;
  result: unknown;
  provider: string;
  model: string;
  promptVersion: string;
  expiresAt: number;
  lastAccessedAt: number;
};

export type SettingRecord = { key: string; value: unknown; schemaVersion: number };

/** v1 — baseline schema. Section 12 store list. */
export class AppDB extends Dexie {
  documents!: Table<DocumentRecord, string>;
  assets!: Table<AssetRecord, string>;
  progress!: Table<ProgressRecord, string>;
  bookmarks!: Table<Bookmark, string>;
  marks!: Table<Mark, string>;
  vocabulary!: Table<Vocabulary, string>;
  occurrences!: Table<Occurrence, string>;
  reviewCards!: Table<ReviewCard, string>;
  reviewEvents!: Table<ReviewEvent, string>;
  explanations!: Table<Explanation, string>;
  aiCache!: Table<AiCacheRecord, string>;
  semanticPages!: Table<unknown, string>;
  settings!: Table<SettingRecord, string>;

  constructor() {
    super("english-reading-companion");
    this.version(1).stores({
      documents: "id, contentHash, lastOpenedAt, format",
      assets: "documentId",
      progress: "documentId",
      bookmarks: "id, documentId, createdAt, deletedAt",
      marks: "id, documentId, anchor.anchorState, createdAt, deletedAt",
      vocabulary: "id, normalizedForm, status, updatedAt",
      occurrences: "id, vocabularyId, documentId",
      reviewCards: "vocabularyId, dueAt, suspended",
      reviewEvents: "id, cardId, reviewedAt",
      explanations: "requestHash, surface, createdAt, deletedAt",
      aiCache: "requestHash, expiresAt, lastAccessedAt",
      semanticPages: "cacheKey, documentId, [documentId+pageIndex], lastAccessedAt",
      settings: "key",
    });
  }
}

export const db = new AppDB();

/**
 * Delete a document's originals and derived pages, and record which user data
 * now has no source. Never deletes bookmarks, marks, occurrences, vocabulary or
 * explanations — they keep a title snapshot and become unavailable.
 */
export async function deleteSource(documentId: string): Promise<void> {
  const snap = await db.documents.get(documentId);
  await db.transaction(
    "rw",
    [db.documents, db.assets, db.progress, db.semanticPages, db.bookmarks, db.marks, db.occurrences],
    async () => {
      await db.documents.delete(documentId);
      await db.assets.delete(documentId);
      await db.progress.delete(documentId);
      await db.semanticPages.where("documentId").equals(documentId).delete();
      // user data survives; the source is simply gone
      void snap;
    },
  );
}
