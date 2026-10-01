/**
 * TXT/Markdown decoding (IDEA.md s8).
 *
 * Pure: bytes in, text or an explicit "choose an encoding" signal out. There is
 * no non-fatal UTF-8 path — a file that will not decode is never handed back
 * with a thousand U+FFFD in it.
 */

export const TEXT_LIMITS = {
  /** s5: 20 MiB for TXT/Markdown. */
  maxBytes: 20 * 1024 * 1024,
} as const;

export type TextEncoding =
  | "utf-8"
  | "utf-16le"
  | "utf-16be"
  | "windows-1252"
  | "iso-8859-1"
  | "windows-1251"
  | "shift_jis";

/** The selector offers a limited set (s8). Unsupported labels in a browser are
 * filtered out by `availableEncodings`. */
export const OFFERED_ENCODINGS: readonly TextEncoding[] = [
  "windows-1252",
  "iso-8859-1",
  "windows-1251",
  "shift_jis",
  "utf-16le",
  "utf-16be",
] as const;

export function availableEncodings(supports: (label: string) => boolean = defaultSupports): TextEncoding[] {
  return OFFERED_ENCODINGS.filter(supports);
}

function defaultSupports(label: string): boolean {
  try {
    new TextDecoder(label, { fatal: true });
    return true;
  } catch {
    return false;
  }
}

export type DecodeResult =
  | { ok: true; text: string; encoding: TextEncoding; byteOffset: number }
  | {
      ok: false;
      reason: "too-large" | "needs-encoding";
      detail: string;
      /** Only present for `needs-encoding`. */
      offered?: TextEncoding[];
    };

const BOM_UTF8 = [0xef, 0xbb, 0xbf];
const BOM_UTF16LE = [0xff, 0xfe];
const BOM_UTF16BE = [0xfe, 0xff];
const BOM_UTF32LE = [0xff, 0xfe, 0x00, 0x00];
const BOM_UTF32BE = [0x00, 0x00, 0xfe, 0xff];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

function hasNul(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 4096);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Decode with an explicit encoding, for the user-chosen retry path. Throws-free:
 * reports failure instead of producing replacement characters.
 */
export function decodeWith(bytes: Uint8Array, encoding: TextEncoding): DecodeResult {
  if (encoding === "utf-8" || encoding === "utf-16le" || encoding === "utf-16be") {
    return decodeAuto(bytes);
  }
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      reason: "needs-encoding",
      detail: `bytes are not valid ${encoding}`,
      offered: availableEncodings(),
    };
  }
  if (text.includes("�")) {
    return { ok: false, reason: "needs-encoding", detail: `bytes are not valid ${encoding}`, offered: availableEncodings() };
  }
  return { ok: true, text, encoding, byteOffset: 0 };
}

/**
 * UTF-8 first, BOM-aware. UTF-16/32 BOMs are honoured because a BOM is
 * unambiguous evidence, not a guess. Otherwise a BOM-less UTF-16 file (NUL in
 * byte stream) is reported as needing an encoding instead of decoding as
 * NUL-interleaved garbage.
 */
export function decodeAuto(bytes: Uint8Array, limits: typeof TEXT_LIMITS = TEXT_LIMITS): DecodeResult {
  if (bytes.byteLength > limits.maxBytes) {
    return { ok: false, reason: "too-large", detail: `${bytes.byteLength} bytes exceeds limit ${limits.maxBytes}` };
  }

  if (startsWith(bytes, BOM_UTF8)) {
    return { ok: true, text: decodeStrict(bytes.subarray(3), "utf-8"), encoding: "utf-8", byteOffset: 3 };
  }
  if (startsWith(bytes, BOM_UTF32LE) || startsWith(bytes, BOM_UTF32BE)) {
    // UTF-32 is not in the selector; treat as unsupported rather than truncate.
    return { ok: false, reason: "needs-encoding", detail: "UTF-32 content is not supported", offered: availableEncodings() };
  }
  if (startsWith(bytes, BOM_UTF16LE)) {
    return { ok: true, text: decodeStrict(bytes.subarray(2), "utf-16le"), encoding: "utf-16le", byteOffset: 2 };
  }
  if (startsWith(bytes, BOM_UTF16BE)) {
    return { ok: true, text: decodeStrict(bytes.subarray(2), "utf-16be"), encoding: "utf-16be", byteOffset: 2 };
  }

  if (hasNul(bytes)) {
    return {
      ok: false,
      reason: "needs-encoding",
      detail: "NUL bytes in a BOM-less file suggest UTF-16 or a binary file",
      offered: availableEncodings(),
    };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      reason: "needs-encoding",
      detail: "bytes are not valid UTF-8; choose an encoding to continue",
      offered: availableEncodings(),
    };
  }
  return { ok: true, text, encoding: "utf-8", byteOffset: 0 };
}

function decodeStrict(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    // Only reachable for a corrupt stream after a BOM: return what survives
    // minus the replacement characters rather than the whole file as U+FFFD.
    return new TextDecoder(encoding, { fatal: false }).decode(bytes).replace(/�/g, "");
  }
}

/**
 * Byte offset of a JS string index, for locators that must survive a save as
 * bytes. Counts UTF-8 code units: `index` is measured in UTF-16 code units, so
 * a surrogate pair contributes 2 to the index and 4 to the byte count.
 */
export function utf8Offset(text: string, index: number): number {
  let bytes = 0;
  const limit = Math.min(index, text.length);
  for (let i = 0; i < limit; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
