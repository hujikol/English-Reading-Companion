import { describe, expect, it } from "vitest";
import {
  contentHashOf,
  extractionKey,
  isSameContent,
  isSha256,
  newDocumentId,
  reconcileDuplicate,
  sha256,
  toHex,
  type Sha256,
} from "../../src/features/library/identity.ts";
import { handleHash } from "../../src/workers/import.worker.ts";

describe("document ids", () => {
  it("are random, prefixed, and not derived from the filename", () => {
    const a = newDocumentId(globalThis.crypto);
    const b = newDocumentId(globalThis.crypto);
    expect(a).toMatch(/^doc_[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("sha256", () => {
  it("matches the known empty-input digest", async () => {
    expect(await sha256(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches the known abc digest", async () => {
    expect(await sha256(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("agrees across typed-array views of the same bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const viaView = await sha256(bytes.subarray(2, 5));
    const viaCopy = await sha256(new Uint8Array([3, 4, 5]));
    expect(viaView).toBe(viaCopy);
  });

  it("produces 64 lowercase hex chars and no geometry", async () => {
    const h = await sha256(new Uint8Array([9, 9]));
    expect(isSha256(h)).toBe(true);
    expect(h).not.toMatch(/bbox|rect|coord/i);
  });

  it("toHex agrees with digest for an empty buffer", () => {
    expect(toHex(new Uint8Array([]))).toBe("");
  });
});

describe("deduplication by exact bytes", () => {
  const h1 = "a".repeat(64) as Sha256;
  const h2 = "b".repeat(64) as Sha256;

  it("treats an unknown hash as a new document", () => {
    expect(reconcileDuplicate(h1, new Map(), "doc_1")).toEqual({ kind: "new", documentId: "doc_1" });
  });

  it("treats a hash already stored under another id as a duplicate", () => {
    const m = new Map<Sha256, string>([[h1, "doc_existing"]]);
    expect(reconcileDuplicate(h1, m, "doc_new")).toEqual({ kind: "duplicate", existingDocumentId: "doc_existing" });
  });

  it("does not call a document a duplicate of itself", () => {
    const m = new Map<Sha256, string>([[h1, "doc_1"]]);
    expect(reconcileDuplicate(h1, m, "doc_1")).toEqual({ kind: "new", documentId: "doc_1" });
  });

  it("never dedups an identity whose hash has not landed yet", () => {
    const pending = { documentId: "doc_temp", stage: "pending" } as const;
    const ready = { documentId: "doc_other", contentHash: h1, stage: "ready" } as const;
    expect(isSameContent(pending, ready)).toBe(false);
    expect(contentHashOf(pending)).toBeUndefined();
  });

  it("matches only equal hashes, never metadata", () => {
    const a = { documentId: "a", contentHash: h1, stage: "ready" } as const;
    const b = { documentId: "b", contentHash: h1, stage: "ready" } as const;
    const c = { documentId: "c", contentHash: h2, stage: "ready" } as const;
    expect(isSameContent(a, b)).toBe(true);
    expect(isSameContent(a, c)).toBe(false);
  });
});

describe("extraction key", () => {
  const parts = { contentHash: "c".repeat(64) as Sha256, parserEngine: "inspector-wasm", parserVersion: "1.0.0", optionsHash: "o", normalizerVersion: "2", pageIndex: 7 };

  it("changes when the parser version changes", () => {
    expect(extractionKey(parts)).not.toBe(extractionKey({ ...parts, parserVersion: "1.0.1" }));
  });

  it("changes when the page changes but not when the id does", () => {
    expect(extractionKey(parts)).not.toBe(extractionKey({ ...parts, pageIndex: 8 }));
    expect(extractionKey(parts)).toContain("inspector-wasm");
  });
});

describe("import worker", () => {
  it("hashes the original bytes and echoes the request id", async () => {
    const bytes = new TextEncoder().encode("abc").buffer;
    const r = await handleHash({ requestId: "r1", type: "HASH", bytes });
    expect(r).toEqual({ requestId: "r1", ok: true, contentHash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
  });

  it("reports failure instead of throwing into the message handler", async () => {
    const r = await handleHash({ requestId: "r2", type: "NOPE" as never, bytes: new ArrayBuffer(0) });
    expect(r).toMatchObject({ requestId: "r2", ok: false });
  });
});
