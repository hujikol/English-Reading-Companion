import { describe, expect, it } from "vitest";
import {
  EPUB_LIMITS,
  checkSectionLength,
  detectDrm,
  validateEpubContainer,
  validateZip,
} from "../../src/features/reader/epub/zip-validate.ts";
import { buildZip, CONTAINER_XML, OPF_XML, utf8, type FixtureEntry } from "./zip-fixtures.ts";

function reason(bytes: Uint8Array): string {
  const result = validateZip(bytes);
  return result.ok ? "ok" : result.reason;
}

const OK_ENTRIES: FixtureEntry[] = [
  { name: "mimetype", body: utf8("application/epub+zip"), method: 0 },
  { name: "META-INF/container.xml", body: utf8(CONTAINER_XML) },
  { name: "OEBPS/content.opf", body: utf8(OPF_XML) },
  { name: "OEBPS/ch1.xhtml", body: utf8("<html><body><p>Hello world.</p></body></html>") },
];

describe("epub zip validation: well-formed", () => {
  it("accepts a small reflowable container", () => {
    const result = validateZip(buildZip(OK_ENTRIES));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.name)).toContain("OEBPS/ch1.xhtml");
    expect(result.totals.entries).toBe(4);
    expect(validateEpubContainer(result).ok).toBe(true);
  });

  it("rejects a file with no end-of-central-directory record", () => {
    expect(reason(utf8("PK\u0003\u0004not really a zip"))).toBe("not-a-zip");
    expect(reason(new Uint8Array(0))).toBe("not-a-zip");
  });
});

describe("epub zip validation: path traversal (s18)", () => {
  it("rejects a parent-directory entry", () => {
    const bytes = buildZip([{ name: "../../../../etc/passwd", body: utf8("root") }]);
    expect(reason(bytes)).toBe("path-traversal");
  });

  it("rejects traversal hidden inside a normal-looking directory", () => {
    const bytes = buildZip([{ name: "OEBPS/../../evil.xhtml", body: utf8("<p>x</p>") }]);
    expect(reason(bytes)).toBe("path-traversal");
  });

  it("rejects absolute, UNC and drive-qualified paths", () => {
    expect(reason(buildZip([{ name: "/etc/shadow", body: utf8("x") }]))).toBe("absolute-path");
    expect(reason(buildZip([{ name: "//evil.example.com/a.xhtml", body: utf8("x") }]))).toBe("absolute-path");
    expect(reason(buildZip([{ name: "C:/Windows/system.ini", body: utf8("x") }]))).toBe("absolute-path");
  });

  it("rejects backslash separators and control characters in names", () => {
    expect(reason(buildZip([{ name: "OEBPS\\..\\..\\evil.xhtml", body: utf8("x") }]))).toBe("invalid-name");
    expect(reason(buildZip([{ name: "OEBPS/a\nb.xhtml", body: utf8("x") }]))).toBe("invalid-name");
  });
});

describe("epub zip validation: decompression bombs (s5, s18)", () => {
  it("rejects a forged compressed size that implies a ratio above 100:1", () => {
    // 4 MiB of zeros claiming a 40 KB compressed size is ~105:1. The ceiling is
    // enforced against DECLARED sizes, before a byte is ever decompressed.
    const bytes = buildZip([
      { name: "bomb.bin", body: new Uint8Array(4 * 1024 * 1024), declaredCompressed: 40_000 },
    ]);
    const result = validateZip(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["expanded-bytes", "expansion-ratio"]).toContain(result.reason);
  });

  it("rejects a declared expansion past 100 MiB", () => {
    const bytes = buildZip([
      { name: "bomb.bin", body: utf8("small"), declaredExpanded: 101 * 1024 * 1024 },
    ]);
    expect(reason(bytes)).toBe("expanded-bytes");
  });

  it("rejects a forged expanded size even when the payload is small", () => {
    const bytes = buildZip([{ name: "lie.bin", body: utf8("small"), declaredExpanded: 200 * 1024 * 1024 }]);
    expect(reason(bytes)).toBe("expanded-bytes");
  });

  it("rejects a forged compressed size beyond the compressed ceiling", () => {
    const bytes = buildZip([{ name: "lie.bin", body: utf8("small"), declaredCompressed: 30 * 1024 * 1024 }]);
    expect(reason(bytes)).toBe("compressed-bytes");
  });

  it("rejects the entry-count limit from the declared count alone", () => {
    // A forged EOCD claiming 4 billion entries must not drive a parse loop.
    const bytes = buildZip(OK_ENTRIES);
    const eocd = bytes.length - 22;
    bytes.set([0xff, 0xff], eocd + 10);
    const result = validateZip(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["entry-count", "not-a-zip"]).toContain(result.reason);
  });

  it("enforces the entry-count limit with real entries", () => {
    const many: FixtureEntry[] = [];
    for (let i = 0; i < EPUB_LIMITS.maxEntries + 1; i++) {
      many.push({ name: `OEBPS/f${i}.xhtml`, body: utf8("<p>x</p>"), method: 0 });
    }
    expect(reason(buildZip(many))).toBe("entry-count");
  });

  it("bounds each individual section", () => {
    expect(checkSectionLength(EPUB_LIMITS.maxSectionBytes).ok).toBe(true);
    expect(checkSectionLength(EPUB_LIMITS.maxSectionBytes + 1)).toEqual({
      ok: false,
      reason: "section-bytes",
      detail: expect.stringContaining("exceeds limit"),
    });
  });
});

describe("epub zip validation: encryption and DRM (s8)", () => {
  it("rejects ZipCrypto-encrypted entries", () => {
    const bytes = buildZip([{ name: "OEBPS/ch1.xhtml", body: utf8("<p>x</p>"), flags: 0x01 }]);
    const result = validateZip(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("encrypted");
  });

  it("rejects AES-encrypted entries (DRM method 99)", () => {
    const bytes = buildZip([{ name: "OEBPS/ch1.xhtml", body: utf8("<p>x</p>"), method: 99 }]);
    const result = validateZip(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("encrypted");
  });

  it("rejects strong encryption (flag bit 6)", () => {
    const bytes = buildZip([{ name: "OEBPS/ch1.xhtml", body: utf8("<p>x</p>"), flags: 0x40 }]);
    expect(reason(bytes)).toBe("encrypted");
  });

  it("rejects a container declaring encryption.xml even when nothing is encrypted", () => {
    const bytes = buildZip([
      { name: "mimetype", body: utf8("application/epub+zip"), method: 0 },
      { name: "META-INF/container.xml", body: utf8(CONTAINER_XML) },
      { name: "META-INF/encryption.xml", body: utf8("<encryption/>") },
      { name: "OEBPS/content.opf", body: utf8(OPF_XML) },
    ]);
    const inner = validateZip(bytes);
    expect(inner.ok).toBe(true);
    if (!inner.ok) return;
    const result = validateEpubContainer(inner);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("encrypted");
    expect(detectDrm(inner.entries).ok).toBe(false);
  });

  it("rejects a container missing container.xml", () => {
    const bytes = buildZip([{ name: "OEBPS/content.opf", body: utf8(OPF_XML) }]);
    const inner = validateZip(bytes);
    expect(inner.ok).toBe(true);
    if (!inner.ok) return;
    expect(validateEpubContainer(inner).ok).toBe(false);
  });

  it("rejects an unsupported compression method", () => {
    const bytes = buildZip([{ name: "OEBPS/ch1.xhtml", body: utf8("<p>x</p>"), method: 14 }]);
    expect(reason(bytes)).toBe("unsupported-method");
  });
});

describe("epub zip validation: malformed input never throws", () => {
  it("survives truncation at every length", () => {
    const bytes = buildZip(OK_ENTRIES);
    for (let cut = 0; cut < bytes.length; cut += 7) {
      const result = validateZip(bytes.subarray(0, cut));
      expect(typeof result.ok).toBe("boolean");
      if (!result.ok) expect(typeof result.reason).toBe("string");
    }
  });

  it("survives random bytes", () => {
    for (let seed = 0; seed < 40; seed++) {
      const junk = new Uint8Array(512);
      for (let i = 0; i < junk.length; i++) junk[i] = (seed * 31 + i * 17) & 0xff;
      expect(typeof validateZip(junk).ok).toBe("boolean");
    }
  });

  it("rejects a forged central-directory offset past end of file", () => {
    const bytes = buildZip(OK_ENTRIES);
    const eocd = bytes.length - 22;
    bytes.set([0xff, 0xff, 0xff, 0xff], eocd + 16);
    const result = validateZip(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["truncated-central-directory", "not-a-zip"]).toContain(result.reason);
  });
});
