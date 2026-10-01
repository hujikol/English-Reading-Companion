import { describe, expect, it } from "vitest";
import { blockAtOffset, chunkText } from "../../src/features/reader/text/chunk.ts";
import { TEXT_LIMITS, availableEncodings, decodeAuto, decodeWith, utf8Offset } from "../../src/features/reader/text/decode.ts";

const utf8Bytes = (s: string) => new TextEncoder().encode(s);

describe("txt decoding: UTF-8 and BOM handling (s8)", () => {
  it("decodes plain UTF-8", () => {
    const result = decodeAuto(utf8Bytes("Once upon a time."));
    expect(result).toMatchObject({ ok: true, encoding: "utf-8", byteOffset: 0, text: "Once upon a time." });
  });

  it("strips a UTF-8 BOM and reports the offset it consumed", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8Bytes("Hello")]);
    const result = decodeAuto(bytes);
    expect(result).toMatchObject({ ok: true, encoding: "utf-8", byteOffset: 3, text: "Hello" });
  });

  it("honours a UTF-16LE BOM", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    expect(decodeAuto(bytes)).toMatchObject({ ok: true, encoding: "utf-16le", text: "Hi" });
  });

  it("honours a UTF-16BE BOM", () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69]);
    expect(decodeAuto(bytes)).toMatchObject({ ok: true, encoding: "utf-16be", text: "Hi" });
  });

  it("decodes non-ASCII text without loss", () => {
    const text = "naïve café — über Straße, 日本語";
    expect(decodeAuto(utf8Bytes(text))).toMatchObject({ ok: true, text });
  });
});

describe("txt decoding: signals instead of replacement characters (s8)", () => {
  it("refuses a deliberately broken file rather than emitting U+FFFD", () => {
    // Lone continuation bytes and a truncated 3-byte sequence.
    const bytes = new Uint8Array([0x48, 0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x82]);
    const result = decodeAuto(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("needs-encoding");
    expect(result.detail).toMatch(/not valid UTF-8/);
    expect(result.offered).toBeDefined();
    expect(result.offered?.length).toBeGreaterThan(0);
  });

  it("never returns text containing U+FFFD for a broken file", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x80, 0x81]);
    const result = decodeAuto(bytes);
    if (result.ok) expect(result.text).not.toContain("�");
    else expect(result.reason).toBe("needs-encoding");
  });

  it("refuses a BOM-less UTF-16 file instead of NUL-interleaved garbage", () => {
    const bytes = new Uint8Array([0x48, 0x00, 0x69, 0x00, 0x21, 0x00]);
    const result = decodeAuto(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("needs-encoding");
  });

  it("refuses UTF-32 rather than truncating it", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]);
    expect(decodeAuto(bytes).ok).toBe(false);
  });

  it("re-decodes with a user-chosen encoding", () => {
    // windows-1252 bytes for "café".
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    const result = decodeWith(bytes, "windows-1252");
    expect(result).toMatchObject({ ok: true, encoding: "windows-1252", text: "café" });
  });

  it("still reports failure when the chosen encoding is wrong", () => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    expect(decodeWith(bytes, "shift_jis").ok).toBe(false);
  });

  it("offers only encodings the platform can actually decode", () => {
    const all = availableEncodings(() => true);
    expect(all).toContain("windows-1252");
    const none = availableEncodings(() => false);
    expect(none).toEqual([]);
  });

  it("enforces the 20 MiB limit", () => {
    const result = decodeAuto(new Uint8Array(TEXT_LIMITS.maxBytes + 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-large");
  });
});

describe("txt chunking: stable offsets and line breaks (s8)", () => {
  const SOURCE = "Chapter 1\n\nFirst paragraph with\na soft line break.\n\nSecond paragraph.\n\n\nThird paragraph.";

  it("splits on blank lines and keeps internal line breaks", () => {
    const blocks = chunkText(SOURCE);
    expect(blocks.map((b) => b.text)).toEqual([
      "Chapter 1",
      "First paragraph with\na soft line break.",
      "Second paragraph.",
      "Third paragraph.",
    ]);
  });

  it("labels headings but never derives a locator from them", () => {
    const blocks = chunkText(SOURCE);
    expect(blocks[0]?.kind).toBe("heading");
    expect(blocks[0]?.blockId).toBe("txt-0");
    // Duplicate headings get distinct IDs because IDs come from offsets.
    const dupes = chunkText("Chapter 1\n\ntext\n\nChapter 1\n\nmore");
    expect(new Set(dupes.map((b) => b.blockId)).size).toBe(dupes.length);
  });

  it("slices back to the exact source text", () => {
    const blocks = chunkText(SOURCE);
    for (const block of blocks) {
      expect(SOURCE.slice(block.start, block.end)).toBe(block.text);
    }
  });

  it("keeps blocks in ascending, non-overlapping order", () => {
    const blocks = chunkText(SOURCE);
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i]!.start).toBeGreaterThanOrEqual(blocks[i - 1]!.end);
    }
  });

  it("is deterministic across repeated calls", () => {
    expect(chunkText(SOURCE)).toEqual(chunkText(SOURCE));
  });

  it("splits a very long paragraph at a line boundary", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const blocks = chunkText(long, { maxChars: 60 });
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.end - block.start).toBeLessThanOrEqual(60 + 20);
      expect(long.slice(block.start, block.end)).toBe(block.text);
    }
  });

  it("handles CRLF, empty and whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  \n")).toEqual([]);
    const crlf = chunkText("one\r\n\r\ntwo");
    expect(crlf.map((b) => b.text)).toEqual(["one", "two"]);
  });

  it("preserves Unicode offsets", () => {
    const source = "café 日本語\n\nsecond";
    const blocks = chunkText(source);
    for (const block of blocks) expect(source.slice(block.start, block.end)).toBe(block.text);
    expect(blockAtOffset(blocks, source.indexOf("second"))?.text).toBe("second");
  });

  it("converts string offsets to byte offsets", () => {
    expect(utf8Offset("abc", 2)).toBe(2);
    expect(utf8Offset("café", 4)).toBe(5);
    expect(utf8Offset("日本", 2)).toBe(6);
    // Index 3 points AT 'b', which is the 6th byte but sits at offset 5.
    expect(utf8Offset("a😀b", 3)).toBe(5);
  });
});
