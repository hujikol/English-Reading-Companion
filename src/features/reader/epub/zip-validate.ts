/**
 * ZIP trust boundary (IDEA.md sections 5, 8, 18).
 *
 * Pure and synchronous: it reads the CENTRAL DIRECTORY only and never
 * materialises entry bytes. Nothing here decompresses, so a decompression
 * bomb cannot allocate memory before it is rejected — the expanded sizes the
 * validator trusts are the ones the extractor will have to produce.
 *
 * Extraction with a per-section byte budget is the renderer's job; see
 * `checkSectionLength`.
 */

export const EPUB_LIMITS = {
  /** IDEA.md s5: 10,000 ZIP entries. */
  maxEntries: 10_000,
  /** s5: 25 MiB compressed. */
  maxCompressedBytes: 25 * 1024 * 1024,
  /** s5: 100 MiB expanded. */
  maxExpandedBytes: 100 * 1024 * 1024,
  /** s5: 100:1 expansion-ratio ceiling. */
  maxExpansionRatio: 100,
  /** ponytail: per-section ceiling so one huge chapter cannot exhaust memory.
   *  Raise only when a real book needs it. */
  maxSectionBytes: 8 * 1024 * 1024,
} as const;

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const ZIP64_EXTRA = 0x0001;
const EOCD_FIXED = 22;
const MAX_COMMENT = 0xffff;
const CENTRAL_FIXED = 46;

export type ZipEntry = {
  name: string;
  compressedBytes: number;
  expandedBytes: number;
  method: number;
  flags: number;
  directory: boolean;
};

export type ZipRejectReason =
  | "not-a-zip"
  | "truncated-central-directory"
  | "entry-count"
  | "compressed-bytes"
  | "expanded-bytes"
  | "section-bytes"
  | "expansion-ratio"
  | "path-traversal"
  | "absolute-path"
  | "invalid-name"
  | "encrypted"
  | "unsupported-method";

export type ZipTotals = {
  entries: number;
  compressedBytes: number;
  expandedBytes: number;
  ratio: number;
};

export type ZipValidation =
  | { ok: true; entries: ZipEntry[]; totals: ZipTotals }
  | { ok: false; reason: ZipRejectReason; detail: string; totals: ZipTotals };

const ZERO_TOTALS: ZipTotals = { entries: 0, compressedBytes: 0, expandedBytes: 0, ratio: 0 };

function u16(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0;
}

/** 64-bit read as a JS number. ZIP64 values above 2^53 are rejected as absurd
 * rather than silently rounded. */
function u64(b: Uint8Array, o: number): number | null {
  const hi = u32(b, o + 4);
  const lo = u32(b, o);
  if (hi > 0x1fffff) return null;
  return hi * 0x1_0000_0000 + lo;
}

function findEocd(bytes: Uint8Array): number {
  const floor = Math.max(0, bytes.length - EOCD_FIXED - MAX_COMMENT);
  for (let i = bytes.length - EOCD_FIXED; i >= floor; i--) {
    if (u32(bytes, i) === SIG_EOCD) return i;
  }
  return -1;
}

const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;
const DRIVE_PREFIX = /^[a-zA-Z]:/;

/** Names are untrusted text. UTF-8 only when the author set the flag; a
 * non-UTF-8, non-ASCII name is refused rather than guessed at. */
function decodeName(bytes: Uint8Array, utf8Flag: boolean): { name: string } | { reason: ZipRejectReason; detail: string } {
  let name: string;
  if (utf8Flag) {
    name = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (name.includes("�")) return { reason: "invalid-name", detail: "name is not valid UTF-8" };
  } else {
    for (const byte of bytes) {
      if (byte > 0x7e) return { reason: "invalid-name", detail: "non-ASCII name without UTF-8 flag" };
    }
    name = String.fromCharCode(...bytes);
  }
  return { name };
}

/** Returns a rejection reason, or null when the path is a safe relative path. */
function rejectPath(name: string): { reason: ZipRejectReason; detail: string } | null {
  if (ASCII_CONTROL.test(name)) return { reason: "invalid-name", detail: `control character in ${JSON.stringify(name)}` };
  if (name.includes("\\")) return { reason: "invalid-name", detail: `backslash separator in ${JSON.stringify(name)}` };
  if (name.startsWith("/")) return { reason: "absolute-path", detail: `absolute path ${JSON.stringify(name)}` };
  if (name.startsWith("//")) return { reason: "absolute-path", detail: `UNC path ${JSON.stringify(name)}` };
  if (DRIVE_PREFIX.test(name)) return { reason: "absolute-path", detail: `drive-qualified path ${JSON.stringify(name)}` };
  if (name.includes("//")) return { reason: "invalid-name", detail: `empty segment in ${JSON.stringify(name)}` };
  for (const segment of name.split("/")) {
    if (segment === "..") return { reason: "path-traversal", detail: `traversal segment in ${JSON.stringify(name)}` };
  }
  return null;
}

function methodName(method: number): string {
  switch (method) {
    case 0:
      return "store";
    case 8:
      return "deflate";
    case 99:
      return "aes";
    default:
      return `method-${method}`;
  }
}

/** Flags: bit 0 = ZipCrypto, bit 5 = strong encryption, bit 6 = patched data,
 * bit 13 = masked local header values (values in the central directory are
 * therefore untrustworthy), bit 11 = UTF-8 names. */
function encryptionProblem(flags: number, method: number, name: string): { reason: ZipRejectReason; detail: string } | null {
  if (method === 99) {
    return { reason: "encrypted", detail: `AES-encrypted entry ${JSON.stringify(name)} (DRM or password protection is not supported)` };
  }
  if ((flags & 0x01) !== 0) return { reason: "encrypted", detail: `ZipCrypto-encrypted entry ${JSON.stringify(name)}` };
  if ((flags & 0x40) !== 0) return { reason: "encrypted", detail: `strong-encrypted entry ${JSON.stringify(name)}` };
  return null;
}

/**
 * Validate ZIP central-directory metadata against `limits`.
 * Rejects traversal paths, unsupported compression, any encryption, and every
 * Section 5 size bound. Never throws on malformed input.
 */
export function validateZip(bytes: Uint8Array, limits: typeof EPUB_LIMITS = EPUB_LIMITS): ZipValidation {
  const eocd = findEocd(bytes);
  if (eocd < 0) return { ok: false, reason: "not-a-zip", detail: "no end-of-central-directory record", totals: ZERO_TOTALS };

  let entryCount = u16(bytes, eocd + 10);
  let cdSize = u32(bytes, eocd + 12);
  let cdOffset = u32(bytes, eocd + 16);
  const needsZip64 = entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;

  if (needsZip64) {
    const locator = eocd - 20;
    if (locator < 0 || u32(bytes, locator) !== SIG_EOCD64_LOCATOR) {
      return { ok: false, reason: "not-a-zip", detail: "ZIP64 locator missing", totals: ZERO_TOTALS };
    }
    const eocd64 = u64(bytes, locator + 8);
    if (eocd64 === null || eocd64 + 56 > bytes.length || u32(bytes, eocd64) !== SIG_EOCD64) {
      return { ok: false, reason: "truncated-central-directory", detail: "ZIP64 end-of-central-directory missing", totals: ZERO_TOTALS };
    }
    const zCount = u64(bytes, eocd64 + 32);
    const zSize = u64(bytes, eocd64 + 40);
    const zOffset = u64(bytes, eocd64 + 48);
    if (zCount === null || zSize === null || zOffset === null) {
      return { ok: false, reason: "not-a-zip", detail: "ZIP64 sizes exceed 2^53", totals: ZERO_TOTALS };
    }
    entryCount = zCount;
    cdSize = zSize;
    cdOffset = zOffset;
  }

  // Declared-count bound first: a forged 4-billion-entry header must not cost
  // us a parse loop.
  if (entryCount > limits.maxEntries) {
    return {
      ok: false,
      reason: "entry-count",
      detail: `${entryCount} entries exceeds limit ${limits.maxEntries}`,
      totals: { ...ZERO_TOTALS, entries: entryCount },
    };
  }
  if (cdOffset + cdSize > bytes.length || cdOffset < 0) {
    return { ok: false, reason: "truncated-central-directory", detail: "central directory extends past end of file", totals: ZERO_TOTALS };
  }

  const entries: ZipEntry[] = [];
  const totals: ZipTotals = { entries: 0, compressedBytes: 0, expandedBytes: 0, ratio: 0 };
  let cursor = cdOffset;

  for (let index = 0; index < entryCount; index++) {
    if (cursor + CENTRAL_FIXED > bytes.length || u32(bytes, cursor) !== SIG_CENTRAL) {
      return { ok: false, reason: "truncated-central-directory", detail: `entry ${index} header invalid`, totals };
    }
    const flags = u16(bytes, cursor + 8);
    const method = u16(bytes, cursor + 10);
    let compressedBytes = u32(bytes, cursor + 20);
    let expandedBytes = u32(bytes, cursor + 24);
    const nameLen = u16(bytes, cursor + 28);
    const extraLen = u16(bytes, cursor + 30);
    const commentLen = u16(bytes, cursor + 32);
    const headerEnd = cursor + CENTRAL_FIXED + nameLen + extraLen + commentLen;
    if (headerEnd > bytes.length) {
      return { ok: false, reason: "truncated-central-directory", detail: `entry ${index} header truncated`, totals };
    }

    const nameBytes = bytes.subarray(cursor + CENTRAL_FIXED, cursor + CENTRAL_FIXED + nameLen);
    const extra = bytes.subarray(cursor + CENTRAL_FIXED + nameLen, cursor + CENTRAL_FIXED + nameLen + extraLen);

    if (compressedBytes === 0xffffffff || expandedBytes === 0xffffffff) {
      const z = readZip64Sizes(extra, compressedBytes === 0xffffffff, expandedBytes === 0xffffffff);
      if (!z) return { ok: false, reason: "not-a-zip", detail: `entry ${index} ZIP64 sizes invalid`, totals };
      if (z.compressedBytes !== null) compressedBytes = z.compressedBytes;
      if (z.expandedBytes !== null) expandedBytes = z.expandedBytes;
    }

    const decoded = decodeName(nameBytes, (flags & 0x800) !== 0);
    if ("reason" in decoded) return { ok: false, reason: decoded.reason, detail: decoded.detail, totals };

    const badPath = rejectPath(decoded.name);
    if (badPath) return { ok: false, reason: badPath.reason, detail: badPath.detail, totals };

    const enc = encryptionProblem(flags, method, decoded.name);
    if (enc) return { ok: false, reason: enc.reason, detail: enc.detail, totals };

    const directory = decoded.name.endsWith("/");
    if (!directory && method !== 0 && method !== 8) {
      return { ok: false, reason: "unsupported-method", detail: `${methodName(method)} is not supported (${decoded.name})`, totals };
    }

    totals.entries += 1;
    if (!directory) {
      totals.compressedBytes += compressedBytes;
      totals.expandedBytes += expandedBytes;
    }
    entries.push({
      name: decoded.name,
      compressedBytes,
      expandedBytes,
      method,
      flags,
      directory,
    });
    cursor = headerEnd;
  }

  totals.ratio = Math.round(totals.expandedBytes / Math.max(1, totals.compressedBytes) * 100) / 100;

  if (totals.entries > limits.maxEntries) {
    return { ok: false, reason: "entry-count", detail: `${totals.entries} entries exceeds limit ${limits.maxEntries}`, totals };
  }
  if (totals.compressedBytes > limits.maxCompressedBytes) {
    return {
      ok: false,
      reason: "compressed-bytes",
      detail: `${totals.compressedBytes} compressed bytes exceeds limit ${limits.maxCompressedBytes}`,
      totals,
    };
  }
  if (totals.expandedBytes > limits.maxExpandedBytes) {
    return {
      ok: false,
      reason: "expanded-bytes",
      detail: `${totals.expandedBytes} expanded bytes exceeds limit ${limits.maxExpandedBytes}`,
      totals,
    };
  }
  if (totals.ratio > limits.maxExpansionRatio) {
    return {
      ok: false,
      reason: "expansion-ratio",
      detail: `expansion ratio ${totals.ratio}:1 exceeds limit ${limits.maxExpansionRatio}:1`,
      totals,
    };
  }
  return { ok: true, entries, totals };
}

function readZip64Sizes(
  extra: Uint8Array,
  needCompressed: boolean,
  needExpanded: boolean,
): { compressedBytes: number | null; expandedBytes: number | null } | null {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = u16(extra, at);
    const size = u16(extra, at + 2);
    const body = at + 4;
    if (body + size > extra.length) return null;
    if (id === ZIP64_EXTRA) {
      let cursor = body;
      let compressedBytes: number | null = null;
      let expandedBytes: number | null = null;
      if (needExpanded) {
        if (cursor + 8 > body + size) return null;
        expandedBytes = u64(extra, cursor);
        cursor += 8;
      }
      if (needCompressed) {
        if (cursor + 8 > body + size) return null;
        compressedBytes = u64(extra, cursor);
      }
      if (expandedBytes === null || compressedBytes === null) return { compressedBytes: null, expandedBytes: null };
      return { compressedBytes, expandedBytes };
    }
    at = body + size;
  }
  return null;
}

/** Per-section content length. Called by the extractor with the byte count it
 * is about to inflate/decode, not with the declared size. */
export function checkSectionLength(byteLength: number, limits: typeof EPUB_LIMITS = EPUB_LIMITS): { ok: true } | { ok: false; reason: ZipRejectReason; detail: string } {
  if (byteLength > limits.maxSectionBytes) {
    return {
      ok: false,
      reason: "section-bytes",
      detail: `section of ${byteLength} bytes exceeds limit ${limits.maxSectionBytes}`,
    };
  }
  return { ok: true };
}

/** DRM detection for already-validated entry lists: a container that ships
 * `META-INF/encryption.xml` is rejected even when nothing is actually
 * encrypted, because it declares protected resources. */
export function detectDrm(entries: readonly ZipEntry[]): { ok: true } | { ok: false; detail: string } {
  for (const entry of entries) {
    if (entry.name.toUpperCase() === "META-INF/ENCRYPTION.XML") {
      return { ok: false, detail: "container declares encrypted resources (META-INF/encryption.xml)" };
    }
    if (entry.flags & 0x40) return { ok: false, detail: `strong encryption declared by ${entry.name}` };
  }
  return { ok: true };
}

/** Container-level checks on a validated archive. */
export function validateEpubContainer(validation: ZipValidation): ZipValidation {
  if (!validation.ok) return validation;
  const drm = detectDrm(validation.entries);
  if (!drm.ok) return { ok: false, reason: "encrypted", detail: drm.detail, totals: validation.totals };
  const hasContainer = validation.entries.some((e) => e.name === "META-INF/container.xml");
  if (!hasContainer) {
    return { ok: false, reason: "invalid-name", detail: "missing META-INF/container.xml", totals: validation.totals };
  }
  return validation;
}
