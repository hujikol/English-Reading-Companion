import type { AppDB } from "../../src/db/index.ts";
import { isolatedDb } from "../faults.ts";
import { describe, expect, it } from "vitest";
import type { Anchor, Bookmark, Explanation, LearningExplanation, Mark } from "../../src/contracts/index.ts";
import type { ReviewEvent } from "../../src/db/index.ts";
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  LIMITS,
  UNENCRYPTED_WARNING,
  exportBackup,
  previewRestore,
  restoreBackup,
  validateBackup,
} from "../../src/features/settings/backup/backup.ts";
import { applyGrade, setDailySessionSize } from "../../src/features/review/queue.ts";
import { capture, editMeaning } from "../../src/features/vocabulary/capture.ts";

const anchor = (quote: string, state: Anchor["anchorState"] = "resolved"): Anchor => ({
  quote,
  prefix: "the",
  suffix: "here",
  locator: { kind: "pdf", pageIndex: 1, pageFraction: 0.5 },
  anchorState: state,
  resolvedAt: 1_700_000_000_000,
});

const explanation = (): Omit<Explanation, "surface" | "createdAt"> => ({
  id: "exp-1",
  requestHash: "hash-1",
  documentId: "doc-1",
  contextText: "They leverage focus.",
  result: {
    naturalTranslation: "memanfaatkan",
    partOfSpeech: "verb",
    provider: "fixture",
    model: "fixture-1",
    promptVersion: "v1",
  } satisfies LearningExplanation,
  provider: "fixture",
  model: "fixture-1",
  promptVersion: "v1",
});

/**
 * Every required user-data category with distinct lifecycle states: a soft-deleted
 * bookmark and mark, a lost anchor, a Known card, a Learning card, a vocabulary
 * row the user edited away from its generated explanation, and a source that no
 * longer exists locally.
 */
async function fullProfile(store: AppDB) {
  const saved = await capture(
    store,
    {
      surface: "leverage",
      anchor: anchor("leverage focus"),
      titleSnapshot: "Deep Work",
      sentence: "They leverage focus.",
      documentId: "gone-doc",
      meaning: "memanfaatkan",
      lemma: "leverage",
      note: "lihat bab 3",
      provenance: { kind: "ai", sourceVersion: "fixture-1@v1" },
      explanation: explanation(),
    },
    { now: 1_000 },
  );
  const edited = await editMeaning(store, saved.vocabulary.id, "memanfaatkan (arti lain)", { now: 2_000 });

  await capture(store, {
    surface: "yield",
    anchor: anchor("yield", "lost"),
    titleSnapshot: "Deep Work",
    sentence: "Yield the result.",
    documentId: "gone-doc",
    meaning: "menghasilkan",
  }, { now: 3_000 });

  await store.bookmarks.put({
    id: "bm-1",
    documentId: "gone-doc",
    titleSnapshot: "Deep Work",
    locator: { kind: "pdf", pageIndex: 2, pageFraction: 0.1 },
    label: "Bagian 1",
    createdAt: 10,
    updatedAt: 20,
  } satisfies Bookmark);
  await store.bookmarks.put({
    id: "bm-2",
    documentId: "doc-live",
    titleSnapshot: "Other",
    locator: { kind: "text", blockId: "b1", start: 0, end: 5 },
    label: "deleted one",
    createdAt: 11,
    updatedAt: 21,
    deletedAt: 99,
  } satisfies Bookmark);
  await store.marks.put({
    id: "mk-1",
    documentId: "gone-doc",
    titleSnapshot: "Deep Work",
    anchor: anchor("leverage focus"),
    color: "yellow",
    createdAt: 30,
  } satisfies Mark);
  await store.marks.put({
    id: "mk-2",
    documentId: "doc-live",
    titleSnapshot: "Other",
    anchor: anchor("soft deleted", "unresolved"),
    color: "blue",
    createdAt: 31,
    deletedAt: 98,
  } satisfies Mark);

  await applyGrade(store, saved.vocabulary.id, "got-it", "rev-1", 5_000);
  await setDailySessionSize(store, 15);
  // settings that are not learning preferences must never leave the device
  await store.settings.put({ key: "ai.apiKey", value: "sk-secret", schemaVersion: 1 });
  await store.settings.put({ key: "library.lastOpened", value: "gone-doc", schemaVersion: 1 });

  return { edited, saved };
}

describe("export", () => {
  it("covers every required user-data category and declares itself unencrypted", async () => {
    const store = isolatedDb(`backup-${++seq}`);
    await fullProfile(store);
    const file = await exportBackup(store, 9_000);

    expect(file.format).toBe(BACKUP_FORMAT);
    expect(file.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(file.exportedAt).toBe(9_000);
    expect(file.encrypted).toBe(false);
    expect(file.notice).toBe(UNENCRYPTED_WARNING);
    expect(file.source.app).toBe("english-reading-companion");
    expect(Object.keys(file.data).sort()).toEqual([
      "bookmarks", "explanations", "marks", "occurrences", "reviewCards", "reviewEvents", "settings", "vocabulary",
    ]);
    expect(file.counts).toMatchObject({
      bookmarks: 2, marks: 2, vocabulary: 2, occurrences: 2, explanations: 1, reviewCards: 2, reviewEvents: 1,
    });
    expect(file.data.reviewEvents).toHaveLength(1);
    expect(file.data.vocabulary.filter((v) => v.explanationText).length).toBe(1);
    // soft-deleted rows and lost anchors are data too
    expect(file.data.bookmarks.filter((b) => b.deletedAt)).toHaveLength(1);
    expect(file.data.marks.filter((m) => m.anchor.anchorState === "unresolved")).toHaveLength(1);
    expect(file.data.occurrences.filter((o) => o.documentId === undefined)).toHaveLength(0);
    // a checksum per section, so a truncated or hand-edited file is detectable
    for (const [name, sum] of Object.entries(file.checksums)) expect(sum, name).toMatch(/^[0-9a-f]{64}$/);
  });

  it("excludes API keys and replaceable derived caches", async () => {
    const store = isolatedDb(`backup-${++seq}`);
    await fullProfile(store);
    const raw = JSON.stringify(await exportBackup(store));

    expect(raw).not.toContain("sk-secret");
    expect(raw).not.toContain("ai.apiKey");
    expect(raw).not.toContain("library.lastOpened");
    expect(file(raw)).not.toContain("semanticPages");
    expect(file(raw)).not.toContain("aiCache");
    expect(JSON.parse(raw).data.settings).toEqual([{ key: "review.dailySessionSize", value: 15, schemaVersion: 1 }]);
  });

  it("is stable across exports of unchanged data", async () => {
    const store = isolatedDb(`backup-${++seq}`);
    await fullProfile(store);
    const a = await exportBackup(store, 1);
    const b = await exportBackup(store, 2);
    expect(a.checksums).toEqual(b.checksums);
  });
});

const file = (raw: string): Record<string, unknown> => JSON.parse(raw) as Record<string, unknown>;

describe("round trip into a fresh profile", () => {
  it("restores every row, verbatim, including edits, anchors and unavailable sources", async () => {
    const source = isolatedDb(`backup-${++seq}`);
    const { edited } = await fullProfile(source);
    const raw = JSON.stringify(await exportBackup(source, 9_000));

    const fresh = isolatedDb(`backup-${++seq}`);
    expect(await fresh.vocabulary.count()).toBe(0);
    const result = await restoreBackup(fresh, raw);

    expect(result.restored).toBe(13);
    // every table matches byte for byte
    expect(await fresh.bookmarks.toArray()).toEqual(await source.bookmarks.toArray());
    expect(await fresh.marks.toArray()).toEqual(await source.marks.toArray());
    expect(await fresh.vocabulary.toArray()).toEqual(await source.vocabulary.toArray());
    expect(await fresh.occurrences.toArray()).toEqual(await source.occurrences.toArray());
    expect(await fresh.explanations.toArray()).toEqual(await source.explanations.toArray());
    expect(await fresh.reviewCards.toArray()).toEqual(await source.reviewCards.toArray());
    expect((await fresh.reviewEvents.toArray()) as ReviewEvent[]).toEqual(await source.reviewEvents.toArray());

    // the specific facts that are easy to lose
    const restored = (await fresh.vocabulary.get(edited.id)) as typeof edited;
    expect(restored.meaning).toBe("memanfaatkan (arti lain)");
    expect(restored.explanationText).toContain("memanfaatkan");
    expect(restored.explanationEditedAt).toBe(2_000);
    expect(restored.provenance.userEdited).toBe(true);

    const lost = (await fresh.occurrences.toArray()) as { anchor: Anchor; documentId?: string }[];
    expect(lost.map((o) => o.anchor.anchorState).sort()).toEqual(["lost", "resolved"]);
    // a source the fresh profile has never seen: the snapshot travels with the data
    expect(lost.every((o) => o.documentId === "gone-doc")).toBe(true);
    const bm = (await fresh.bookmarks.toArray()) as Bookmark[];
    expect(bm.map((b) => b.titleSnapshot).sort()).toEqual(["Deep Work", "Other"]);
    expect(bm.find((b) => b.id === "bm-2")?.deletedAt).toBe(99);
  });

  it("restores into a second profile without re-running any sibling UI", async () => {
    const source = isolatedDb(`backup-${++seq}`);
    await fullProfile(source);
    const raw = JSON.stringify(await exportBackup(source));
    const a = isolatedDb(`backup-${++seq}`);
    const b = isolatedDb(`backup-${++seq}`);
    await restoreBackup(a, raw);
    await restoreBackup(b, raw);
    expect(await a.vocabulary.toArray()).toEqual(await b.vocabulary.toArray());
  });
});

describe("merge behaviour", () => {
  it("preserves a local edit made after the export", async () => {
    const source = isolatedDb(`backup-${++seq}`);
    const { saved } = await fullProfile(source);
    const raw = JSON.stringify(await exportBackup(source));

    // the same profile keeps working and the learner changes the meaning again
    const local = isolatedDb(`backup-${++seq}`);
    await restoreBackup(local, raw);
    await editMeaning(local, saved.vocabulary.id, "arti lokal", { now: 20_000 });

    const again = await restoreBackup(local, raw);
    const row = (await local.vocabulary.get(saved.vocabulary.id)) as { meaning: string };
    expect(row.meaning).toBe("arti lokal");
    expect(again.preservedEdits.vocabulary).toBe(2);
    expect(again.added.vocabulary).toBe(0);
    expect(again.restored).toBe(0);
  });

  it("previews added, preserved and conflicting rows before writing", async () => {
    const source = isolatedDb(`backup-${++seq}`);
    await fullProfile(source);
    const raw = JSON.stringify(await exportBackup(source));

    const local = isolatedDb(`backup-${++seq}`);
    await restoreBackup(local, raw);
    await local.bookmarks.put({ id: "bm-3", documentId: "d", titleSnapshot: "t", locator: { kind: "text", blockId: "b", start: 0, end: 1 }, label: "new", createdAt: 1, updatedAt: 1 } satisfies Bookmark);

    const preview = await previewRestore(local, JSON.parse(raw) as never);
    expect(preview.added.bookmarks).toBe(0);
    expect(preview.preservedEdits.bookmarks).toBe(2);
    expect(preview.conflicts.bookmarks).toBe(0);
    expect(preview.added.occurrences).toBe(0);
    expect(preview.encrypted).toBe(false);
    expect(preview.notice).toBe(UNENCRYPTED_WARNING);

    // now a genuine conflict: same id, different content
    const conflicted = isolatedDb(`backup-${++seq}`);
    await restoreBackup(conflicted, raw);
    await conflicted.bookmarks.put({ id: "bm-1", documentId: "gone-doc", titleSnapshot: "Renamed locally", locator: { kind: "pdf", pageIndex: 2, pageFraction: 0.1 }, label: "Bagian 1", createdAt: 10, updatedAt: 999 } satisfies Bookmark);
    const preview2 = await previewRestore(conflicted, JSON.parse(raw) as never);
    expect(preview2.conflicts.bookmarks).toBe(1);
    expect(preview2.preservedEdits.bookmarks).toBe(2);
  });

  it("replace mode clears local rows first", async () => {
    const source = isolatedDb(`backup-${++seq}`);
    await fullProfile(source);
    const raw = JSON.stringify(await exportBackup(source));
    const local = isolatedDb(`backup-${++seq}`);
    await local.vocabulary.put({ id: "stale", surface: "stale", normalizedForm: "stale", meaning: "lama", status: "learning", provenance: { kind: "manual", createdAt: 1, userEdited: false }, createdAt: 1, updatedAt: 1 });

    await restoreBackup(local, raw, { mode: "replace" });
    expect((await local.vocabulary.toArray()).map((v) => (v as { id: string }).id)).not.toContain("stale");
    expect(await local.vocabulary.count()).toBe(2);
  });
});

let seq = 0;

describe("hostile and oversized input", () => {
  const good = async (): Promise<string> => {
    const store = isolatedDb(`backup-${++seq}`);
    await fullProfile(store);
    return JSON.stringify(await exportBackup(store));
  };

  it("rejects oversized input before any write", async () => {
    const store = isolatedDb(`backup-${++seq}`);
    const raw = await good();
    const huge = `${"x".repeat(LIMITS.maxBytes + 1)}${raw}`;
    await expect(restoreBackup(store, huge)).rejects.toThrow(/too large/);
    expect(await store.vocabulary.count()).toBe(0);
    expect(await store.occurrences.count()).toBe(0);
  });

  it("rejects excessive nesting before any write", async () => {
    const store = isolatedDb(`backup-${++seq}`);
    let nested: unknown = "deep";
    for (let i = 0; i < LIMITS.maxDepth + 4; i++) nested = { [`level${i}`]: nested };
    const base = JSON.parse(await good()) as { data: Record<string, unknown> };
    const hostile = JSON.stringify({ ...base, data: { ...base.data, marks: [nested] } });

    await expect(restoreBackup(store, hostile)).rejects.toThrow(/nesting deeper/);
    expect(await store.marks.count()).toBe(0);
    expect(await store.vocabulary.count()).toBe(0);
  });

  it("rejects unsafe keys", async () => {
    const store = isolatedDb(`backup-${++seq}`);
    const payload = JSON.parse(await good()) as { data: { vocabulary: unknown[] } };
    payload.data.vocabulary = [JSON.parse('{"__proto__": {"admin": true}, "id": "evil", "surface": "x", "normalizedForm": "x", "meaning": "x", "status": "learning", "provenance": {"kind":"manual","createdAt":1,"userEdited":false}, "createdAt": 1, "updatedAt": 1}')];
    await expect(restoreBackup(store, JSON.stringify(payload))).rejects.toThrow(/unsafe key/);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(await store.vocabulary.count()).toBe(0);
  });

  it("rejects a row without a primary key", async () => {
    const store = isolatedDb(`backup-${++seq}`);
    const payload = JSON.parse(await good()) as { data: { marks: unknown[] } };
    payload.data.marks = [{ documentId: "d", titleSnapshot: "t", anchor: anchor("q"), color: "red", createdAt: 1 }];
    await expect(restoreBackup(store, JSON.stringify(payload))).rejects.toThrow(/missing string primary key/);
    expect(await store.marks.count()).toBe(0);
  });

  it("rejects a tampered row through the checksum", async () => {
    const store = isolatedDb(`backup-${++seq}`);
    const payload = JSON.parse(await good()) as { data: { vocabulary: { id: string; meaning: string }[] } };
    payload.data.vocabulary[0]!.meaning = "diteruskan";
    await expect(restoreBackup(store, JSON.stringify(payload))).rejects.toThrow(/checksum mismatch in vocabulary/);
    expect(await store.vocabulary.count()).toBe(0);
  });

  it("refuses a newer format instead of clearing anything", async () => {
    const store = isolatedDb(`backup-${++seq}`);
    const payload = JSON.parse(await good()) as { formatVersion: number };
    payload.formatVersion = BACKUP_FORMAT_VERSION + 1;
    await expect(restoreBackup(store, JSON.stringify(payload))).rejects.toThrow(/newer than this build/);
    expect(await store.vocabulary.count()).toBe(0);
  });

  it("rejects malformed JSON, a foreign format and a missing section", async () => {
    const store = isolatedDb(`backup-${++seq}`);
    await expect(restoreBackup(store, "{not json")).rejects.toThrow(/not valid JSON/);

    const foreign = JSON.parse(await good()) as Record<string, unknown>;
    foreign.format = "somebody-elses-backup";
    await expect(restoreBackup(store, JSON.stringify(foreign))).rejects.toThrow(/expected erc.learning-backup/);

    const partial = JSON.parse(await good()) as { data: Record<string, unknown> };
    delete partial.data.reviewEvents;
    await expect(restoreBackup(store, JSON.stringify(partial))).rejects.toThrow(/not an array/);
    expect(await store.vocabulary.count()).toBe(0);
  });

  it("rejects unknown sections so a hostile file cannot smuggle tables in", async () => {
    const store = isolatedDb(`backup-${++seq}`);
    const payload = JSON.parse(await good()) as { data: Record<string, unknown> };
    payload.data.hiddenTable = [{ id: "x" }];
    await expect(restoreBackup(store, JSON.stringify(payload))).rejects.toThrow(/unknown section/);
    expect(await store.vocabulary.count()).toBe(0);
  });

  it("validateBackup throws on a section that is not an array of objects", () => {
    expect(() => validateBackup(JSON.stringify({ format: BACKUP_FORMAT, formatVersion: 1, exportedAt: 1, encrypted: false, checksums: {}, data: {} }))).toThrow();
  });
});