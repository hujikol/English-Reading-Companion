/**
 * Library model over the real `validatePdfImport` and `identity` modules.
 *
 * Rules under test: untrusted filenames, byte signatures decide, honest
 * persistence claims, dedup by exact bytes, real CSV/backup bytes out.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { DocumentRecord } from "../../../src/db/index.ts";
import { exportBackup, UNENCRYPTED_WARNING } from "../../../src/features/settings/backup/backup.ts";
import { exportVocabularyCsv } from "../../../src/features/settings/backup/csv.ts";
import { capture } from "../../../src/features/vocabulary/capture.ts";
import type { Store } from "../../../src/features/vocabulary/store.ts";
import {
  announceExport,
  backupFileName,
  buildLibraryRows,
  csvFileName,
  exportOutcomeOf,
  formatBytes,
  formatOf,
  importDocument,
  planImport,
  positionLabelOf,
  titleFromName,
  type ImportSource,
} from "../../../src/ui/library/libraryModel.ts";
import { memStore } from "../../vocabulary/memStore.ts";

/** a minimal valid PDF: header + one object + a closing marker */
const pdfBytes = (label: string): Uint8Array =>
  new TextEncoder().encode(`%PDF-1.7\n1 0 obj\n<< /Title (${label}) >>\nendobj\ntrailer\n%%EOF\n`);

const source = (name: string, bytes: Uint8Array, type = "application/pdf"): ImportSource => ({
  name,
  type,
  size: bytes.byteLength,
  head: bytes.subarray(0, Math.min(bytes.byteLength, 1024)),
  bytes,
});

let store: Store;

beforeEach(() => {
  store = memStore();
});

describe("format detection", () => {
  it("reads the extension but never treats it as proof", () => {
    expect(formatOf("book.PDF")).toBe("pdf");
    expect(formatOf("book.epub")).toBe("epub");
    expect(formatOf("notes.MD")).toBe("md");
    expect(formatOf("archive.tar.gz")).toBeNull();
    expect(formatOf("noextension")).toBeNull();
    expect(titleFromName("  Digital Life.pdf ")).toBe("Digital Life");
  });

  it("rejects a renamed non-PDF on the byte signature, not the name", () => {
    const bytes = new TextEncoder().encode("PK\u0003\u0004 not really an epub");
    const plan = planImport(source("fake.pdf", bytes, "application/pdf"));
    expect(plan.kind).toBe("rejected");
    if (plan.kind === "rejected") expect(plan.errors[0]!.code).toBe("unsupported-format");
  });

  it("rejects an unsupported extension with an actionable error", () => {
    const plan = planImport(source("notes.docx", new TextEncoder().encode("x")));
    expect(plan.kind).toBe("rejected");
    if (plan.kind === "rejected") {
      expect(plan.errors[0]!.code).toBe("unsupported-extension");
      expect(plan.errors[0]!.action).toContain("PDF");
    }
  });

  it("passes a real PDF through with its notices intact", () => {
    const plan = planImport(source("book.pdf", pdfBytes("Book")));
    expect(plan.kind).toBe("accepted");
    if (plan.kind === "accepted") {
      expect(plan.format).toBe("pdf");
      expect(plan.documentId).toMatch(/^doc_[0-9a-f]{32}$/);
      expect(plan.title).toBe("book");
      expect(plan.validation.ok).toBe(true);
    }
  });
});

describe("import", () => {
  const persisted: DocumentRecord[] = [];

  it("hashes the bytes, saves, and only then claims it is ready", async () => {
    const outcome = await importDocument(
      source("book.pdf", pdfBytes("Book")),
      {
        persist: async (document) => {
          persisted.push(document);
          // `persist` writes the row AND the bytes together, so the row is in
          // its final state at the moment it is written. It used to be written
          // as "saving" with the intent of promoting it afterwards — nothing
          // ever did that, so every stored document stayed "saving" and the
          // library's Open button stayed disabled forever.
          expect(document.importState).toBe("ready");
          expect(document.contentHash).toMatch(/^[0-9a-f]{64}$/);
        },
        findByHash: async () => undefined,
        now: 1000,
      },
      "desktop",
    );
    expect(outcome.kind).toBe("imported");
    if (outcome.kind === "imported") {
      expect(outcome.reused).toBe(false);
      expect(outcome.document.importState).toBe("ready");
      expect(outcome.document.importedAt).toBe(1000);
      expect(outcome.document.byteSize).toBeGreaterThan(0);
    }
    expect(persisted).toHaveLength(1);
  });

  it("reports temporary, not saved, when the write fails", async () => {
    const outcome = await importDocument(
      source("book.pdf", pdfBytes("Book")),
      {
        persist: () => Promise.reject(new Error("quota exceeded")),
        findByHash: async () => undefined,
      },
      "desktop",
    );
    expect(outcome.kind).toBe("temporary");
    if (outcome.kind === "temporary") {
      expect(outcome.message).toBe("quota exceeded");
      // A failed write never claims to be saved.
      expect(outcome.document.importState).not.toBe("ready");
    }
  });

  it("reuses an identical file instead of writing a second document", async () => {
    const existing: DocumentRecord = {
      id: "doc_existing",
      contentHash: "a".repeat(64),
      title: "book",
      originalName: "book.pdf",
      format: "pdf",
      byteSize: 10,
      importedAt: 1,
      lastOpenedAt: 1,
      importState: "ready",
    };
    let writes = 0;
    const bytes = pdfBytes("Book");
    // first import stores it
    const first = await importDocument(
      source("book.pdf", bytes),
      { persist: async () => void writes++, findByHash: async () => undefined, now: 1 },
      "desktop",
    );
    if (first.kind !== "imported") throw new Error("first import should succeed");
    const stored: DocumentRecord = { ...existing, contentHash: first.document.contentHash ?? "" };

    // second import of the same bytes
    const second = await importDocument(
      source("copy-of-book.pdf", bytes),
      { persist: async () => void writes++, findByHash: async () => stored, now: 2 },
      "desktop",
    );
    expect(second.kind).toBe("reused");
    if (second.kind === "reused") {
      expect(second.document.id).toBe("doc_existing");
      // saved vocabulary and progress are untouched
      expect(second.document.lastOpenedAt).toBe(1);
    }
    expect(writes).toBe(1);
  });

  it("does not hash or write a rejected file", async () => {
    let writes = 0;
    const outcome = await importDocument(source("x.docx", new TextEncoder().encode("hello")), {
      persist: async () => void writes++,
      findByHash: async () => undefined,
    });
    expect(outcome.kind).toBe("rejected");
    expect(writes).toBe(0);
  });
});

describe("library rows", () => {
  const doc = (id: string, state: DocumentRecord["importState"], lastOpenedAt = 10): DocumentRecord => ({
    id,
    title: id,
    originalName: `${id}.pdf`,
    format: "pdf",
    byteSize: 100,
    importedAt: 1,
    lastOpenedAt,
    importState: state,
  });

  it("never claims Saved for a temporary or failed document", () => {
    const rows = buildLibraryRows([doc("a", "ready", 20), doc("b", "temporary", 30), doc("c", "saving", 15), doc("d", "failed", 5)], []);
    const byId = new Map(rows.map((r) => [r.document.id, r]));
    expect(byId.get("a")!.storageLabel).toBe("Saved on this device — no position yet");
    expect(byId.get("b")!.storageLabel).toBe("Temporary session only");
    expect(byId.get("b")!.savedLocally).toBe(false);
    expect(byId.get("c")!.storageLabel).toBe("Saving…");
    expect(byId.get("d")!.storageLabel).toBe("Save failed");
    // most recently opened first
    expect(rows.map((r) => r.document.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("labels a position without inventing pages for a chapter format", () => {
    expect(positionLabelOf(undefined)).toBe("Not started");
    expect(
      positionLabelOf({
        documentId: "a",
        locator: { kind: "pdf", pageIndex: 4, pageFraction: 0 },
        progression: 0.2,
        updatedAt: 1,
        revision: 1,
      }),
    ).toBe("Page 5");
    expect(
      positionLabelOf({
        documentId: "a",
        locator: { kind: "epub", spineHref: "ch3.xhtml" },
        progression: 0.2,
        updatedAt: 1,
        revision: 1,
      }),
    ).toBe("ch3.xhtml");
  });
});

describe("export", () => {
  it("produces real backup bytes with the unencrypted warning", async () => {
    await capture(store, {
      surface: "ubiquitous",
      anchor: { quote: "ubiquitous", locator: { kind: "text", blockId: "b", start: 0, end: 1 }, anchorState: "resolved" },
      titleSnapshot: "Book",
      sentence: "A sentence.",
      meaning: "tersedia di mana-mana",
    });
    const file = await exportBackup(store, 1_700_000_000_000);
    expect(file.format).toBe("erc.learning-backup");
    expect(file.notice).toBe(UNENCRYPTED_WARNING);
    expect(file.counts.vocabulary).toBe(1);

    const outcome = exportOutcomeOf(backupFileName(1_700_000_000_000), JSON.stringify(file));
    expect(outcome.kind).toBe("exported");
    if (outcome.kind === "exported") {
      expect(outcome.fileName).toBe("erc-backup-2023-11-14.json");
      expect(outcome.byteSize).toBeGreaterThan(0);
      expect(announceExport(outcome)).toBe("Exported erc-backup-2023-11-14.json.");
    }
  });

  it("produces UTF-8 CSV bytes with a BOM", async () => {
    await capture(store, {
      surface: "mobilitas",
      anchor: { quote: "mobilitas", locator: { kind: "text", blockId: "b", start: 0, end: 1 }, anchorState: "resolved" },
      titleSnapshot: "Book",
      sentence: "A sentence.",
      meaning: "kemampuan berpindah",
    });
    const csv = await exportVocabularyCsv(store);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("mobilitas");
    expect(csv).toContain("kemampuan berpindah");
    const outcome = exportOutcomeOf(csvFileName(1_700_000_000_000), csv);
    expect(outcome.kind).toBe("exported");
    if (outcome.kind === "exported") expect(outcome.byteSize).toBeGreaterThan(0);
  });

  it("formats sizes for humans", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});