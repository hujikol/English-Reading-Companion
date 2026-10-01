/**
 * Dictionary pack format, DSL parser and pack builder.
 *
 * Pure: no Dexie, no filesystem, no network. Web-standard APIs only
 * (WebCrypto + CompressionStream) so the exact same code runs in the Node build
 * script and in the browser installer.
 *
 * Track C, IDEA.md section 9.
 */

export const PACK_SCHEMA_VERSION = 1;
export const DEFAULT_CHUNK_ROWS = 2000;

export type Sense = { gloss: string; synonyms: string[] };

/**
 * One row per sense. `senseId` 0 is a "no translation recorded" placeholder
 * row; senses are numbered from 1. Primary key is
 * `[packVersion+normalizedHeadword+senseId]` (IDEA.md section 12).
 */
export type EntryRow = {
  packVersion: string;
  normalizedHeadword: string;
  senseId: number;
  headword: string;
  partOfSpeech: string | null;
  sense: Sense | null;
  aliases: string[];
  irregularForms: string[];
};

export type SourceAttribution = {
  sourceUrl: string;
  sourceRevision: string;
  sourceSha256: string;
  license: string;
  licenseUrl: string;
  attribution: string;
};

export type PackChunkInfo = {
  file: string;
  rawBytes: number;
  compressedBytes: number;
  /** hash of the *uncompressed* payload — identical across runtimes, unlike the gzip bytes */
  rawSha256: string;
  rowCount: number;
};

export type PackManifest = {
  packVersion: string;
  schemaVersion: number;
  builtFrom: SourceAttribution;
  /** rows, not words */
  entryCount: number;
  headwordCount: number;
  senseCount: number;
  rawBytes: number;
  compressedBytes: number;
  chunks: PackChunkInfo[];
};

export type BuiltPack = { manifest: PackManifest; chunks: { file: string; bytes: Uint8Array }[] };

// ---------------------------------------------------------------- normalization

// ponytail: fixed list of lookalikes. A full Unicode confusable table is a
// different trade; add when a real source is found to contain more.
const APOSTROPHES = /[\u2018\u2019\u02bc\u02b9\u0060\u00b4]/g;

/** Lookup key for a surface form. Displayed forms are never altered. */
export const normalizeForm = (form: string): string =>
  form.normalize("NFKC").replace(APOSTROPHES, "'").replace(/\s+/g, " ").trim().toLowerCase();

const dedupe = (xs: string[]): string[] => [...new Set(xs)];

// ---------------------------------------------------------------- hashing / codecs

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  // ponytail: copy into a fresh ArrayBuffer — TS 5.7's Uint8Array is generic
  // over its backing buffer, so a Uint8Array<ArrayBufferLike> is not a
  // BufferSource and crypto.subtle.digest rejects it.
  const src = new Uint8Array(bytes).buffer;
  const digest = await crypto.subtle.digest("SHA-256", src);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

type Codec = { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> };

async function pipe(data: Uint8Array, codec: Codec): Promise<Uint8Array> {
  const writer = codec.writable.getWriter();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = codec.readable.getReader();
  // ponytail: same ArrayBuffer copy as sha256Hex — see note there.
  void writer.write(new Uint8Array(data).buffer).then(
    () => writer.close(),
    (e: unknown) => writer.abort(e),
  );
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      size += value.length;
    }
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const codec = (dir: "compress" | "decompress"): Codec => {
  const Ctor = dir === "compress" ? CompressionStream : DecompressionStream;
  if (typeof Ctor !== "function") throw new Error("gzip streams unavailable in this runtime");
  return new Ctor("gzip") as unknown as Codec;
};

export const gzip = (data: Uint8Array): Promise<Uint8Array> => pipe(data, codec("compress"));
export const gunzip = (data: Uint8Array): Promise<Uint8Array> => pipe(data, codec("decompress"));

// ---------------------------------------------------------------- DSL parsing

export class PackBuildError extends Error {
  line: number | undefined;
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `${message} (line ${line})`);
    this.name = "PackBuildError";
    this.line = line;
  }
}

type RawBlock = {
  headword: string;
  line: number;
  pos: string | null;
  aliases: string[];
  senses: Sense[];
  formOf: string | null;
};

const SENSE_LINE = /^\*-\s*(.+)$/;
const GLOSS_SEPARATOR = /\s*;\s*/;

function parseSenseLine(text: string, line: number): Sense {
  const [gloss = "", ...rest] = text.split(GLOSS_SEPARATOR);
  const trimmed = gloss.trim();
  if (!trimmed) throw new PackBuildError("empty gloss", line);
  return { gloss: trimmed, synonyms: dedupe(rest.map((s) => s.trim()).filter(Boolean)) };
}

/** Split `{{name|arg|arg}}` into name and args. */
function template(line: string): { name: string; args: string[] } | null {
  const m = /^\{\{([a-z-]+)((?:\|[^}]*)?)\}\}$/.exec(line.trim());
  if (!m) return null;
  const args = (m[2] ?? "").split("|").filter((s) => s.length > 0);
  return { name: m[1] as string, args };
}

/**
 * Parses the supported DSL subset. Any other `{{template}}` is a hard error:
 * an unknown construct is never dropped, because dropping it would silently
 * lose meanings (IDEA.md section 9).
 */
export function parseDsl(text: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  let current: RawBlock | null = null;
  let inTranslation = false;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = (lines[i] ?? "").trim();
    if (!line || line.startsWith("#")) continue;

    const heading = /^==\s*(.+?)\s*==(?:\s*\((.+?)\))?$/.exec(line);
    if (heading) {
      if (heading[2] && heading[2] !== "en") {
        throw new PackBuildError(`unsupported language section "${heading[2]}"`, lineNo);
      }
      current = { headword: heading[1] as string, line: lineNo, pos: null, aliases: [], senses: [], formOf: null };
      blocks.push(current);
      inTranslation = false;
      continue;
    }

    if (!current) throw new PackBuildError("content outside an entry block", lineNo);

    const tpl = template(line);
    if (tpl) {
      const { name, args } = tpl;
      if (name === "headword") {
        if (args[0] !== "en") throw new PackBuildError("only {{headword|en|...}} is supported", lineNo);
        current.headword = args[1] ?? current.headword;
      } else if (name === "pos") {
        current.pos = args.join("/") || null;
      } else if (name === "also") {
        current.aliases.push(...args);
      } else if (name === "form-of") {
        if (args[0] !== "en") throw new PackBuildError("only {{form-of|en|lemma}} is supported", lineNo);
        current.formOf = args[1] ?? null;
        if (!current.formOf) throw new PackBuildError("{{form-of}} without a lemma", lineNo);
      } else if (name === "trans-top") {
        if (args[0] !== "Indonesian") throw new PackBuildError("only Indonesian senses are supported", lineNo);
        inTranslation = true;
      } else if (name === "trans-bottom") {
        inTranslation = false;
      } else {
        throw new PackBuildError(`unsupported template {{${name}}} — extend parseDsl before using it`, lineNo);
      }
      continue;
    }

    if (inTranslation) {
      const sense = SENSE_LINE.exec(line);
      if (!sense) throw new PackBuildError(`unparsable sense line "${line}"`, lineNo);
      current.senses.push(parseSenseLine(sense[1] as string, lineNo));
    }
  }
  return blocks;
}

// ---------------------------------------------------------------- assembly

export type BuildOptions = {
  packVersion: string;
  sourceUrl: string;
  sourceRevision: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  chunkRows?: number;
};

/** Turns parsed blocks into sorted, deduplicated rows. Deterministic. */
export function assembleRows(blocks: RawBlock[], packVersion: string): EntryRow[] {
  const byHeadword = new Map<string, RawBlock>();
  const irregular = new Map<string, string[]>();

  for (const b of blocks) {
    if (b.formOf) {
      if (b.senses.length || b.pos) {
        throw new PackBuildError(`form-of block "${b.headword}" also carries senses or pos`, b.line);
      }
      const key = normalizeForm(b.formOf);
      irregular.set(key, [...(irregular.get(key) ?? []), normalizeForm(b.headword)]);
      continue;
    }
    const key = normalizeForm(b.headword);
    if (!key) throw new PackBuildError("empty headword", b.line);
    if (byHeadword.has(key)) throw new PackBuildError(`duplicate headword "${b.headword}"`, b.line);
    byHeadword.set(key, b);
  }

  const rows: EntryRow[] = [];
  for (const [key, b] of byHeadword) {
    const aliases = dedupe(b.aliases.map(normalizeForm).filter(Boolean));
    const forms = dedupe((irregular.get(key) ?? []).filter((f) => f !== key));
    const common = {
      packVersion,
      normalizedHeadword: key,
      headword: b.headword,
      partOfSpeech: b.pos,
      aliases,
      irregularForms: forms,
    };
    if (b.senses.length === 0) {
      rows.push({ ...common, senseId: 0, sense: null });
      continue;
    }
    b.senses.forEach((sense, idx) => rows.push({ ...common, senseId: idx + 1, sense }));
  }

  // deterministic order: normalized headword, then sense id
  rows.sort((a, b) => (a.normalizedHeadword < b.normalizedHeadword ? -1 : a.normalizedHeadword > b.normalizedHeadword ? 1 : a.senseId - b.senseId));
  return rows;
}

/**
 * Builds a pack: normalized rows, deterministic JSON chunks, gzip, manifest.
 * Same input text + options in, byte-identical pack out (gzip bytes may differ
 * between runtimes; `rawSha256` is the cross-runtime integrity check).
 */
export async function buildPack(sourceText: string, opts: BuildOptions): Promise<BuiltPack> {
  if (!opts.packVersion) throw new PackBuildError("packVersion is required");
  const chunkRows = opts.chunkRows ?? DEFAULT_CHUNK_ROWS;
  const rows = assembleRows(parseDsl(sourceText), opts.packVersion);
  if (rows.length === 0) throw new PackBuildError("source produced no entries");

  const chunks: { file: string; bytes: Uint8Array }[] = [];
  const infos: PackChunkInfo[] = [];
  let rawBytes = 0;
  let compressedBytes = 0;

  for (let i = 0, part = 0; i < rows.length; part++) {
    const slice = rows.slice(i, i + chunkRows);
    const payload = utf8(JSON.stringify({ packVersion: opts.packVersion, schemaVersion: PACK_SCHEMA_VERSION, rows: slice }));
    const bytes = await gzip(payload);
    const file = `pack-${opts.packVersion}-${String(part).padStart(4, "0")}.json.gz`;
    rawBytes += payload.length;
    compressedBytes += bytes.length;
    infos.push({ file, rawBytes: payload.length, compressedBytes: bytes.length, rawSha256: await sha256Hex(payload), rowCount: slice.length });
    chunks.push({ file, bytes });
    i += chunkRows;
  }

  const manifest: PackManifest = {
    packVersion: opts.packVersion,
    schemaVersion: PACK_SCHEMA_VERSION,
    builtFrom: {
      sourceUrl: opts.sourceUrl,
      sourceRevision: opts.sourceRevision,
      sourceSha256: await sha256Hex(utf8(sourceText)),
      license: opts.license,
      licenseUrl: opts.licenseUrl,
      attribution: opts.attribution,
    },
    entryCount: rows.length,
    headwordCount: new Set(rows.map((r) => r.normalizedHeadword)).size,
    senseCount: rows.filter((r) => r.sense !== null).length,
    rawBytes,
    compressedBytes,
    chunks: infos,
  };
  return { manifest, chunks };
}

/** Manifest file bytes — stable key order, trailing newline, no timestamps. */
export const serializeManifest = (m: PackManifest): string => `${JSON.stringify(m, null, 2)}\n`;

// ---------------------------------------------------------------- row validation

export const isEntryRow = (v: unknown): v is EntryRow => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Partial<EntryRow>;
  return (
    typeof r.packVersion === "string" &&
    typeof r.normalizedHeadword === "string" &&
    r.normalizedHeadword.length > 0 &&
    typeof r.senseId === "number" &&
    Number.isInteger(r.senseId) &&
    r.senseId >= 0 &&
    typeof r.headword === "string" &&
    (r.partOfSpeech === null || typeof r.partOfSpeech === "string") &&
    Array.isArray(r.aliases) &&
    r.aliases.every((a) => typeof a === "string" && a.length > 0) &&
    Array.isArray(r.irregularForms) &&
    r.irregularForms.every((f) => typeof f === "string" && f.length > 0) &&
    (r.sense === null ||
      (typeof r.sense === "object" &&
        r.sense !== null &&
        typeof (r.sense as Sense).gloss === "string" &&
        (r.sense as Sense).gloss.length > 0 &&
        Array.isArray((r.sense as Sense).synonyms) &&
        (r.sense as Sense).synonyms.every((s) => typeof s === "string")))
  );
};
