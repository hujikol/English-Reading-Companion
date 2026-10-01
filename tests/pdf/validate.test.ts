import { describe, expect, it } from "vitest";
import {
  detectSignature,
  hasPdfExtension,
  isAllowedPdfMime,
  looksEncrypted,
  PDF_MAX_BYTES,
  PDF_PHONE_TIER_BYTES,
  validatePdfImport,
  type ImportInput,
} from "../../src/features/library/validate.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const PDF_HEAD = enc("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");

const base = (over: Partial<ImportInput> = {}): ImportInput => ({
  name: "book.pdf",
  mimeType: "application/pdf",
  byteSize: 1024,
  tier: "desktop",
  head: PDF_HEAD,
  ...over,
});

describe("signature detection is authoritative, not the filename", () => {
  it("detects pdf from bytes", () => {
    expect(detectSignature(PDF_HEAD)).toBe("pdf");
  });

  it("tolerates junk before %PDF- inside the header window", () => {
    expect(detectSignature(enc("\n\n" + "%PDF-1.4"))).toBe("pdf");
  });

  it("names the real format of a renamed file", () => {
    expect(detectSignature(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x72, 0x65, 0x73, 0x74]))).toBe("zip");
    expect(detectSignature(enc("{\\rtf1"))).toBe("rtf");
    expect(detectSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image");
    expect(detectSignature(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image");
    expect(detectSignature(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe("ole");
    expect(detectSignature(enc("just some text"))).toBe("unknown");
  });
});

describe("validatePdfImport", () => {
  it("accepts a well-formed pdf", () => {
    const r = validatePdfImport(base());
    expect(r).toMatchObject({ ok: true, passwordRequired: false, renderOnly: false, semantic: true });
  });

  it("accepts an empty or octet-stream mime but not text/html", () => {
    expect(validatePdfImport(base({ mimeType: "" })).ok).toBe(true);
    expect(validatePdfImport(base({ mimeType: "application/octet-stream" })).ok).toBe(true);
    expect(isAllowedPdfMime("APPLICATION/PDF")).toBe(true);
    expect(isAllowedPdfMime("text/html")).toBe(false);
  });

  it("rejects a zip renamed to .pdf with an actionable message", () => {
    const r = validatePdfImport(base({ head: enc("PK\u0003\u0004\u0000") }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]!.code).toBe("unsupported-format");
    expect(r.errors[0]!.message).toMatch(/ZIP/i);
    expect(r.errors[0]!.action.length).toBeGreaterThan(10);
  });

  it("rejects a damaged file with no header", () => {
    const r = validatePdfImport(base({ head: enc("nothing pdf-like") }));
    expect(r).toMatchObject({ ok: false, state: "failed" });
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]!.code).toBe("damaged");
  });

  it("rejects a pdf extension on a non-pdf mime", () => {
    const r = validatePdfImport(base({ mimeType: "text/html" }));
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]!.code).toBe("mime-mismatch");
  });

  it("rejects pdf bytes without a .pdf name", () => {
    const r = validatePdfImport(base({ name: "book.txt" }));
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]!.code).toBe("unsupported-extension");
    expect(hasPdfExtension("BOOK.PDF")).toBe(true);
    expect(hasPdfExtension("book.pdf.txt")).toBe(false);
  });

  it("rejects an empty file separately from an oversized one", () => {
    const empty = validatePdfImport(base({ byteSize: 0 }));
    if (empty.ok) throw new Error("unreachable");
    expect(empty.errors[0]!.code).toBe("empty");
  });

  it("rejects above the hard 100 MiB limit outright", () => {
    const r = validatePdfImport(base({ byteSize: PDF_MAX_BYTES + 1 }));
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]!.code).toBe("oversized");
    expect(r.errors[0]!.message).toMatch(/100 MiB/);
  });

  it("opens above the phone tier in render-only mode with semantic off", () => {
    const r = validatePdfImport(base({ tier: "phone", byteSize: PDF_PHONE_TIER_BYTES + 1 }));
    expect(r).toMatchObject({ ok: true, renderOnly: true, semantic: false });
    if (!r.ok) throw new Error("unreachable");
    expect(r.notices.some((n) => n.code === "oversized")).toBe(true);
  });

  it("still allows the same file on desktop, where the tier is higher", () => {
    expect(validatePdfImport(base({ tier: "desktop", byteSize: PDF_PHONE_TIER_BYTES + 1 }))).toMatchObject({ ok: true, renderOnly: false });
  });

  it("flags an encrypted trailer without failing the import", () => {
    expect(looksEncrypted(enc("%PDF-1.7\ntrailer /Encrypt 3 0 R"))).toBe(true);
    const r = validatePdfImport(base({ head: enc("%PDF-1.7\ntrailer << /Encrypt 9 0 R >>") }));
    expect(r).toMatchObject({ ok: true, passwordRequired: true });
    if (!r.ok) throw new Error("unreachable");
    expect(r.notices.some((n) => n.code === "encrypted")).toBe(true);
  });

  it("checks bytes before the filename so a bad file is not blamed on its name", () => {
    const r = validatePdfImport(base({ head: new Uint8Array([0x50, 0x4b, 0x03, 0x04]), name: "x.txt" }));
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]!.code).toBe("unsupported-format");
  });
});