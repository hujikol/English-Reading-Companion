import type { Bookmark, Explanation, Mark, Occurrence, Vocabulary } from "../../../contracts/index.ts";
import type { Table } from "dexie";
import type { AppDB, ReviewCard, ReviewEvent } from "../../../db/index.ts";

export const BACKUP_FORMAT = "erc.learning-backup";
export const BACKUP_FORMAT_VERSION = 1;

/** Shown on export and before every import. Unencrypted by design at v0.1. */
export const UNENCRYPTED_WARNING =
  "This file is NOT encrypted. It contains your reading history, source excerpts and personal notes. " +
  "AppDB it somewhere private.";

/** ponytail: caps chosen from a decade of daily use, not from measurement. Raise when a real learner trips them. */
export const LIMITS = { maxBytes: 64 * 1024 * 1024, maxDepth: 12, maxRowsPerSection: 200_000 } as const;

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Learner preference rows that belong to learning data. Secrets are never in `settings`. */
const SETTINGS_PREFIX = "review.";

type Rows = { bookmarks: Bookmark[]; marks: Mark[]; vocabulary: Vocabulary[]; occurrences: Occurrence[]; explanations: Explanation[]; reviewCards: ReviewCard[]; reviewEvents: ReviewEvent[] };

type Section = keyof Rows;

/** primary key per section, mirroring the `stores()` schema in src/db/index.ts */
const SECTION_KEYS: Record<Section | "settings", string> = {
  bookmarks: "id",
  marks: "id",
  vocabulary: "id",
  occurrences: "id",
  explanations: "requestHash",
  reviewCards: "vocabularyId",
  reviewEvents: "id",
  settings: "key",
};

const SECTIONS = Object.keys(SECTION_KEYS) as Section[];

export type BackupFile = {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  exportedAt: number;
  source: { app: string; userAgent: string };
  encrypted: false;
  notice: string;
  counts: Record<Section | "settings", number>;
  checksums: Record<Section | "settings", string>;
  data: Rows & { settings: { key: string; value: unknown; schemaVersion: number }[] };
};

export type RestorePreview = {
  version: number;
  exportedAt: number;
  counts: Record<string, number>;
  /** rows whose id is new locally */
  added: Record<string, number>;
  /** id already present locally; the local row wins under merge */
  preservedEdits: Record<string, number>;
  /** id present with different content; listed, not silently applied */
  conflicts: Record<string, number>;
  encrypted: false;
  notice: string;
};

/** Sorted-key JSON so a checksum does not depend on property insertion order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function exportBackup(store: AppDB, now = Date.now()): Promise<BackupFile> {
  const settings = (await store.settings.toArray()) as { key: string; value: unknown; schemaVersion: number }[];
  const data = {
    bookmarks: (await store.bookmarks.toArray()) as Bookmark[],
    marks: (await store.marks.toArray()) as Mark[],
    vocabulary: (await store.vocabulary.toArray()) as Vocabulary[],
    occurrences: (await store.occurrences.toArray()) as Occurrence[],
    explanations: (await store.explanations.toArray()) as Explanation[],
    reviewCards: (await store.reviewCards.toArray()) as ReviewCard[],
    reviewEvents: (await store.reviewEvents.toArray()) as ReviewEvent[],
    settings: settings.filter((s) => s.key.startsWith(SETTINGS_PREFIX)),
  };

  const checksums = {} as Record<Section | "settings", string>;
  const counts = {} as Record<Section | "settings", number>;
  for (const name of [...SECTIONS, "settings"] as (Section | "settings")[]) {
    checksums[name] = await sha256(canonical(data[name]));
    counts[name] = data[name].length;
  }

  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: now,
    source: { app: "english-reading-companion", userAgent: typeof navigator === "undefined" ? "node" : navigator.userAgent },
    encrypted: false,
    notice: UNENCRYPTED_WARNING,
    counts,
    checksums,
    data,
  };
}

/**
 * Full structural check. Runs to completion before any write, and throws on
 * the first problem: a hostile file must not half-apply.
 */
export function validateBackup(raw: string): BackupFile {
  if (raw.length > LIMITS.maxBytes) throw new Error(`backup too large: ${raw.length} bytes > ${LIMITS.maxBytes}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("backup is not valid JSON");
  }

  const fail = (path: string, why: string): never => {
    throw new Error(`backup rejected at ${path}: ${why}`);
  };

  if (depth(parsed, 1) > LIMITS.maxDepth) fail("$.data", `nesting deeper than ${LIMITS.maxDepth}`);

  const file = asRecord(parsed, "$");
  if (file.format !== BACKUP_FORMAT) fail("$.format", `expected ${BACKUP_FORMAT}`);
  if (typeof file.formatVersion !== "number" || !Number.isInteger(file.formatVersion) || file.formatVersion < 1) {
    fail("$.formatVersion", "not a positive integer");
  }
  // a rolled-back build refuses newer data; it never clears the database to run
  if ((file.formatVersion as number) > BACKUP_FORMAT_VERSION) {
    fail("$.formatVersion", `newer than this build supports (${BACKUP_FORMAT_VERSION})`);
  }
  if (typeof file.exportedAt !== "number" || !Number.isFinite(file.exportedAt)) fail("$.exportedAt", "not a finite timestamp");
  if (file.encrypted !== false) fail("$.encrypted", "only unencrypted backups are supported");

  const data = asRecord(file.data, "$.data");
  for (const key of Object.keys(data)) if (!(key in SECTION_KEYS)) fail("$.data", `unknown section ${key}`);

  const checksums = asRecord(file.checksums, "$.checksums");
  for (const name of [...SECTIONS, "settings"] as (Section | "settings")[]) {
    const rows: unknown[] = Array.isArray(data[name]) ? (data[name] as unknown[]) : fail(`$.data.${name}`, "not an array");
    if (rows.length > LIMITS.maxRowsPerSection) fail(`$.data.${name}`, `more than ${LIMITS.maxRowsPerSection} rows`);
    for (const [i, row] of rows.entries()) {
      const record = asRecord(row, `$.data.${name}[${i}]`);
      const primary = SECTION_KEYS[name];
      if (typeof record[primary] !== "string" || record[primary] === "") {
        fail(`$.data.${name}[${i}]`, `missing string primary key ${primary}`);
      }
    }
    if (typeof checksums[name] !== "string") fail(`$.checksums.${name}`, "missing checksum");
  }

  return file as unknown as BackupFile;
}

/** Verified file. Checksums are compared here so a truncated or edited file never reaches the database. */
export async function verifyChecksums(file: BackupFile): Promise<void> {
  for (const name of [...SECTIONS, "settings"] as (Section | "settings")[]) {
    const actual = await sha256(canonical(file.data[name]));
    if (actual !== file.checksums[name]) throw new Error(`backup rejected: checksum mismatch in ${name}`);
  }
}

/**
 * What an import would do, before it does it. Conflicts are surfaced, not
 * resolved: under merge the local row is preserved because it may hold edits
 * this file predates.
 */
export async function previewRestore(store: AppDB, file: BackupFile): Promise<RestorePreview> {
  const added: Record<string, number> = {};
  const preservedEdits: Record<string, number> = {};
  const conflicts: Record<string, number> = {};

  for (const name of [...SECTIONS, "settings"] as (Section | "settings")[]) {
    const table = tableFor(store, name);
    const primary = SECTION_KEYS[name];
    const local = new Map(
      (await table.toArray()).map((r) => [(r as Record<string, unknown>)[primary] as string, canonical(r)]),
    );
    let newRows = 0;
    let kept = 0;
    let differing = 0;
    for (const row of file.data[name]) {
      const key = (row as Record<string, unknown>)[primary] as string;
      const existing = local.get(key);
      if (existing === undefined) newRows += 1;
      else {
        kept += 1;
        // canonical, not JSON.stringify: key order must not read as an edit
        if (existing !== canonical(row)) differing += 1;
      }
    }
    added[name] = newRows;
    preservedEdits[name] = kept;
    conflicts[name] = differing;
  }

  return {
    version: file.formatVersion,
    exportedAt: file.exportedAt,
    counts: { ...file.counts },
    added,
    preservedEdits,
    conflicts,
    encrypted: false,
    notice: file.notice,
  };
}

function tableFor(store: AppDB, name: Section | "settings"): Table<unknown, string> {
  return name === "settings" ? store.settings : store[name];
}

/**
 * Transactional restore. `merge` (default) inserts only absent ids, so an
 * edit made locally after the export survives. `replace` discards the local
 * learning tables first — destructive and only reachable by explicit choice.
 *
 * Anchor states and every recorded lifecycle timestamp are written verbatim;
 * nothing is re-derived from originals that may no longer exist.
 */
export async function restoreBackup(
  store: AppDB,
  raw: string,
  opts: { mode?: "merge" | "replace" } = {},
): Promise<{ added: Record<string, number>; preservedEdits: Record<string, number>; restored: number }> {
  const file = validateBackup(raw);
  await verifyChecksums(file);
  const mode = opts.mode ?? "merge";
  if (mode === "replace") {
    const all = [...SECTIONS, "settings"] as (Section | "settings")[];
    const tables = all.map((n) => tableFor(store, n));
    await store.transaction("rw", tables, async () => {
      for (const name of all) {
        const table = tableFor(store, name);
        const primary = SECTION_KEYS[name];
        for (const row of await table.toArray()) await table.delete((row as Record<string, unknown>)[primary] as string);
      }
    });
  }

  const preview = await previewRestore(store, file);
  const added: Record<string, number> = {};
  const preservedEdits: Record<string, number> = {};
  let restored = 0;

  for (const name of [...SECTIONS, "settings"] as (Section | "settings")[]) {
    const table = tableFor(store, name);
    const primary = SECTION_KEYS[name];
    const existing = new Set((await table.toArray()).map((r) => (r as Record<string, unknown>)[primary] as string));
    const fresh = file.data[name].filter((r) => !existing.has((r as Record<string, unknown>)[primary] as string));
    preservedEdits[name] = preview.preservedEdits[name] ?? 0;
    added[name] = fresh.length;
    if (fresh.length === 0) continue;
    await store.transaction("rw", [table], async () => {
      await table.bulkPut(fresh as readonly unknown[]);
    });
    restored += fresh.length;
  }

  return { added, preservedEdits, restored };
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`backup rejected at ${path}: not an object`);
  return value as Record<string, unknown>;
}

function depth(value: unknown, level: number): number {
  if (level > LIMITS.maxDepth + 1 || typeof value !== "object" || value === null) return level;
  if (Array.isArray(value)) return value.reduce<number>((max, v) => Math.max(max, depth(v, level + 1)), level);
  let deepest = level;
  for (const [key, v] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) throw new Error(`backup rejected: unsafe key ${key}`);
    deepest = Math.max(deepest, depth(v, level + 1));
  }
  return deepest;
}

export { canonical as canonicalJson, sha256 };