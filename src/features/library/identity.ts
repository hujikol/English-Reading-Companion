/**
 * Document identity. Section 5: a random stable id is assigned immediately, the
 * content hash is computed in the background over the ORIGINAL bytes, and the
 * two are stored separately. A filename or PDF-metadata fingerprint is not
 * sufficient for deduplication, so v0.1 duplicates mean exact bytes.
 */

export type Sha256 = string & { readonly __brand: "sha256" };

const HEX = "0123456789abcdef";

export const isSha256 = (v: unknown): v is Sha256 => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** Random per-install id. Not a hash of anything. */
export const newDocumentId = (crypto: Crypto = globalThis.crypto): string => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const x of b) s += HEX[x >> 4]! + HEX[x & 15]!;
  return `doc_${s}`;
};

export const newBookmarkId = (crypto: Crypto = globalThis.crypto): string => `bm_${newDocumentId(crypto).slice(4)}`;

/** lowercase hex, matching the `contentHash` shape stored by Track A. */
export const toHex = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += HEX[b >> 4]! + HEX[b & 15]!;
  return s;
};

/**
 * Whole-buffer digest. Accepts a ByteSource so tests and browsers can both pass
 * raw bytes without a Blob. ponytail: one allocation for 100 MiB; switch to
 * streaming digestIncremental only if the large-file gate (FG-DEVICE) fails.
 */
export type ByteSource = ArrayBuffer | ArrayBufferView;

export async function sha256(source: ByteSource, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<Sha256> {
  const view = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
  // copy: a Uint8Array over a SharedArrayBuffer or a resizable buffer is not
  // always accepted by digest, and detaching must not be this function's job.
  const digest = await subtle.digest("SHA-256", view.slice().buffer);
  return toHex(new Uint8Array(digest)) as Sha256;
}

/** Identity state before the hash lands. `temporary` is truthful, not a failure. */
export type PendingIdentity = {
  documentId: string;
  contentHash?: undefined;
  /** a session-only cache entry keyed by the temp id, promoted after hashing */
  stage: "pending";
};

export type PromotedIdentity = { documentId: string; contentHash: Sha256; stage: "ready" };

export type Identity = PendingIdentity | PromotedIdentity;

export const contentHashOf = (i: Identity): Sha256 | undefined => (i.stage === "ready" ? i.contentHash : undefined);

/**
 * Promotion bookkeeping: v0.1 deduplicates on exact bytes only. An existing hash
 * means the bytes are already stored, so the caller reuses that document and must
 * not overwrite its saved progress, bookmarks or vocabulary.
 */
export type DuplicateDecision =
  | { kind: "new"; documentId: string }
  | { kind: "duplicate"; existingDocumentId: string };

/** Serialized duplicate check: only complete hashes participate, never a temp id. */
export function reconcileDuplicate(hash: Sha256, existingByHash: ReadonlyMap<Sha256, string>, ownDocumentId: string): DuplicateDecision {
  const existing = existingByHash.get(hash);
  if (existing === undefined || existing === ownDocumentId) return { kind: "new", documentId: ownDocumentId };
  return { kind: "duplicate", existingDocumentId: existing };
}

/**
 * Content hash equality, not metadata equality. Two imports of the same name with
 * different bytes are two documents; the same bytes under two names are one.
 */
export function isSameContent(a: Identity, b: Identity): boolean {
  const ha = contentHashOf(a);
  const hb = contentHashOf(b);
  return ha !== undefined && ha === hb;
}

/** Extracted key identity from Section 6, for derived semantic pages only. */
export const extractionKey = (parts: {
  contentHash: Sha256;
  parserEngine: string;
  parserVersion: string;
  optionsHash: string;
  normalizerVersion: string;
  pageIndex: number;
}): string =>
  [parts.contentHash, parts.parserEngine, parts.parserVersion, parts.optionsHash, parts.normalizerVersion, parts.pageIndex].join("|");
