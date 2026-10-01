/**
 * Section 6 "Extraction key identity".
 *
 * The key is the whole eviction story: `semanticPages` is replaceable derived
 * data, so a parser or normalizer change must invalidate derived pages ONLY.
 * Marks, occurrences and vocabulary are keyed by documentId and must survive.
 * Adding, dropping or reordering a component here is therefore a data-loss
 * decision, not a formatting choice.
 *
 * Text is joined with "|" because no component may contain it: contentHash is
 * fixed-length hex, pageIndex is an integer, the rest are versions. A version
 * containing "|" would be an injection; assert it instead of hoping.
 */

export type ExtractionKeyParts = {
  contentHash: string;
  parserEngine: string;
  parserVersion: string;
  optionsHash: string;
  normalizerVersion: string;
  pageIndex: number;
};

const SEP = "|";

const assertComponent = (name: string, value: string): void => {
  if (value.includes(SEP)) throw new Error(`extraction key component ${name} must not contain "${SEP}": ${value}`);
};

export const extractionKey = (p: ExtractionKeyParts): string => {
  if (!Number.isInteger(p.pageIndex) || p.pageIndex < 0) throw new Error(`pageIndex must be a non-negative integer: ${p.pageIndex}`);
  assertComponent("contentHash", p.contentHash);
  assertComponent("parserEngine", p.parserEngine);
  assertComponent("parserVersion", p.parserVersion);
  assertComponent("optionsHash", p.optionsHash);
  assertComponent("normalizerVersion", p.normalizerVersion);
  return [
    p.contentHash,
    p.parserEngine,
    p.parserVersion,
    p.optionsHash,
    p.normalizerVersion,
    String(p.pageIndex),
  ].join(SEP);
};

/** Every page key for one document identity, in page order. */
export const extractionKeysFor = (
  p: Omit<ExtractionKeyParts, "pageIndex">,
  pageIndexes: readonly number[],
): string[] => pageIndexes.map((pageIndex) => extractionKey({ ...p, pageIndex }));

/**
 * Options identity. Only options that CHANGE OUTPUT belong here; a password is
 * excluded because it is a credential, must never be stored or hashed into a
 * persisted key, and cannot change text for a document that already opened.
 */
export type ExtractionOptions = { profile?: "fidelity" | "compact"; includePageMarkers?: boolean; includeImages?: boolean };

export const optionsHash = (options: ExtractionOptions = {}): string => {
  const normalized = {
    includeImages: options.includeImages ?? false,
    includePageMarkers: options.includePageMarkers ?? false,
    profile: options.profile ?? "fidelity",
  };
  // FNV-1a: short, stable, dependency-free. Not a security boundary.
  let h = 0x811c9dc5;
  const body = JSON.stringify(normalized);
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a32-${h.toString(16).padStart(8, "0")}`;
};
