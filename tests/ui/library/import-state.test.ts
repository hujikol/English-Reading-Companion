import { describe, expect, it } from "vitest";
import { importDocument, type ImportSource } from "../../../src/ui/library/libraryModel.ts";
import type { DocumentRecord } from "../../../src/db/index.ts";

/**
 * Regression: `importDocument` used to persist the document row with
 * importState "saving" and return a "ready" copy that was never written. Every
 * stored document read back as "saving", which the library renders as "not
 * saved on this device" and which disables its Open button permanently.
 *
 * The flag the list reads is the one that was PERSISTED, so that is what this
 * asserts.
 */
const source = (): ImportSource => ({
  name: "book.pdf",
  type: "application/pdf",
  size: 12,
  head: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
  bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x0a, 0x25, 0x00, 0x01, 0x02, 0x03]),
});

describe("importDocument persists a usable state", () => {
  it("writes the row as ready, so the library can open it", async () => {
    const written: DocumentRecord[] = [];
    const outcome = await importDocument(
      source(),
      {
        persist: async (document) => {
          written.push({ ...document });
        },
        findByHash: async () => undefined,
        now: 1_700_000_000_000,
      },
      "desktop",
    );

    expect(outcome.kind).toBe("imported");
    expect(written).toHaveLength(1);
    // The persisted flag is what the library reads back. "saving" here is the
    // exact regression: Open stays disabled forever.
    expect(written[0]?.importState).toBe("ready");
  });

  it("reports temporary and claims nothing when the write fails", async () => {
    // persist writes the row and the bytes in one transaction, so a throw means
    // neither landed. The function must say so rather than report success.
    const outcome = await importDocument(
      source(),
      {
        persist: () => Promise.reject(new Error("quota exceeded")),
        findByHash: async () => undefined,
        now: 1_700_000_000_000,
      },
      "desktop",
    );

    expect(outcome.kind).toBe("temporary");
    if (outcome.kind !== "temporary") return;
    expect(outcome.message).toMatch(/quota/);
    expect(outcome.document.importState).not.toBe("ready");
  });
});
