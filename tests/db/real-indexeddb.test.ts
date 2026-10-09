import { describe, expect, it } from "vitest";
import Dexie from "dexie";
import { AppDB, db } from "../../src/db/index.ts";
import type { Bookmark } from "../../src/contracts/index.ts";

/**
 * Proves the thing that justified deleting the hand-written Store port: tests
 * use the REAL Dexie database, so a hand-rolled structural mirror of it is no
 * longer needed. fake-indexeddb/auto (tests/setup.ts) provides IndexedDB in Node.
 */
const bookmark = (id: string): Bookmark => ({
  id,
  documentId: "doc-1",
  titleSnapshot: "A Book",
  locator: { kind: "pdf", pageIndex: 4, pageFraction: 0.5 },
  label: "Page 5",
  createdAt: 1,
  updatedAt: 1,
});

describe("real IndexedDB in tests", () => {
  it("accepts a write and reads it back through Dexie", async () => {
    await db.bookmarks.put(bookmark("b1"));
    expect(await db.bookmarks.get("b1")).toMatchObject({ id: "b1", label: "Page 5" });
  });

  it("supports bulkDelete, matching Dexie's declared Promise<void>", async () => {
    // dexie.d.ts: `bulkDelete(keys: TKey[]): PromiseExtended<void>`.
    //
    // tests/setup.ts clears every table before each test, so this seeds its own
    // three rows rather than relying on whatever ran before it.
    await db.bookmarks.bulkPut([bookmark("b1"), bookmark("b2"), bookmark("b3")]);
    expect(await db.bookmarks.count()).toBe(3);
    await db.bookmarks.bulkDelete(["b2", "b3"]);
    expect(await db.bookmarks.count()).toBe(1);
    expect((await db.bookmarks.get("b1"))?.id).toBe("b1");
  });

  it("round trips a Blob, so document assets are storable in tests", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await db.assets.put({
      documentId: "doc-1",
      blob: new Blob([bytes], { type: "application/pdf" }),
      mime: "application/pdf",
      byteSize: bytes.length,
      checksum: "x",
    });
    const back = await db.assets.get("doc-1");
    expect(back?.blob).toBeInstanceOf(Blob);
    expect(back?.blob.size).toBe(4);
  });

  it("rolls a failed transaction back", async () => {
    await expect(
      db.transaction("rw", [db.bookmarks], async () => {
        await db.bookmarks.put(bookmark("b4"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.bookmarks.get("b4")).toBeUndefined();
  });
});

it("upgrades legacy explanations without losing snapshots", async () => {
  const name = "explanation-migration-test";
  const legacy = new Dexie(name);
  legacy.version(1).stores({ explanations: "requestHash, surface, createdAt, deletedAt" });
  await legacy.table("explanations").put({ id: "old-id", requestHash: "same-request", surface: "bank", createdAt: 1 });
  legacy.close();
  const upgraded = new AppDB(name);
  try {
    expect(await upgraded.explanations.get("old-id")).toMatchObject({ requestHash: "same-request" });
    await upgraded.explanations.put({ id: "new-id", requestHash: "same-request", surface: "bank", contextText: "river bank", provider: "local", model: "test", promptVersion: "1", result: { naturalTranslation: "tepi sungai", contextualMeaning: "tepi", provider: "local", model: "test", promptVersion: "1" }, createdAt: 2 });
    expect(await upgraded.explanations.count()).toBe(2);
  } finally {
    await upgraded.delete();
  }
});
