/**
 * The dictionary's own IndexedDB, separate from the app DB.
 *
 * Separate instance on purpose: a pack rebuild, a corrupted chunk or a failed
 * upgrade must never be able to touch documents, bookmarks or vocabulary.
 * Losing the dictionary is recoverable (reinstall); losing user data is not
 * (IDEA.md section 12, Track C boundary).
 */

import Dexie, { type Table } from "dexie";

import {
  gunzip,
  isEntryRow,
  type EntryRow,
  type PackManifest,
  type SourceAttribution,
} from "./pack.ts";

/** One row per alias/irregular form, so lookups hit an index and never a scan. */
export type AliasRow = { alias: string; packVersion: string; normalizedHeadword: string };

export type PackState = "staged" | "active" | "retired" | "failed";

export type PackRecord = {
  packVersion: string;
  state: PackState;
  manifest: PackManifest;
  /** rows written and validated so far */
  installedRows: number;
  installedAt: number;
  updatedAt: number;
};

/** Attribution + sizes for the card and Settings. No document data ever lands here. */
export type MetaRecord = {
  key: "meta";
  activePackVersion: string | null;
  attribution: SourceAttribution | null;
  installedAt: number | null;
  compressedBytes: number;
  entryCount: number;
};

export type ActivePackInfo = {
  packVersion: string;
  attribution: SourceAttribution;
  installedAt: number;
  compressedBytes: number;
  entryCount: number;
  headwordCount: number;
  license: string;
  licenseUrl: string;
};

export const DICT_DB_NAME = "english-reading-companion-dictionary";
const META_KEY = "meta" as const;

export class DictionaryDB extends Dexie {
  packs!: Table<PackRecord, string>;
  entries!: Table<EntryRow, [string, string, number]>;
  aliases!: Table<AliasRow, [string, string]>;
  meta!: Table<MetaRecord, string>;

  constructor(name: string = DICT_DB_NAME, deps?: { indexedDB?: IDBFactory; IDBKeyRange?: typeof IDBKeyRange }) {
    super(name, deps);
    this.version(1).stores({
      packs: "packVersion, state, installedAt",
      // IDEA.md section 12: compound key, plus a plain packVersion index for retention
      entries: "[packVersion+normalizedHeadword+senseId], packVersion, partOfSpeech",
      // [alias+packVersion] primary key; `packVersion` alone sweeps one pack
      aliases: "[alias+packVersion], packVersion, normalizedHeadword",
      meta: "key",
    });
  }
}

/** The browser instance. Tests construct their own. */
export const dictDb = new DictionaryDB();

// ---------------------------------------------------------------- helpers

export class PackInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackInstallError";
  }
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];

/** Alias/irregular index rows derived from one entry row, in a stable order. */
export const aliasRowsFor = (row: EntryRow): AliasRow[] =>
  dedupe([...row.aliases, ...row.irregularForms])
    .map((alias) => ({ alias, packVersion: row.packVersion, normalizedHeadword: row.normalizedHeadword }))
    .sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));

const decodeRows = async (bytes: Uint8Array): Promise<EntryRow[]> =>
  (JSON.parse(new TextDecoder().decode(await gunzip(bytes))) as { rows: EntryRow[] }).rows;

// ---------------------------------------------------------------- activation

export type InstallOptions = {
  /** rows per transaction. Default 1000, per IDEA.md section 9. */
  batchSize?: number;
  /** test seam: abort after N chunks have been written. */
  failAfterChunks?: number;
};

export type InstallProgress = { chunksDone: number; chunksTotal: number; rowsDone: number; rowsTotal: number };

export type InstallHooks = {
  onProgress?: (p: InstallProgress) => void;
  /** the only place chunk bytes come in — a fetch, a File, or an in-memory map */
  fetchChunk: (file: string) => Promise<Uint8Array>;
};

/**
 * Installs a pack and makes it active in one atomic step.
 *
 * Order: stage -> write every chunk in bounded transactions -> verify the row
 * count through the index the lookup depends on -> flip `active` and rewrite
 * metadata in a single readwrite transaction -> purge the old version.
 *
 * An interruption at any point before the flip leaves the previous pack active
 * and complete; the half-written version is dropped, never left shadowing it.
 */
export async function installPack(
  db: DictionaryDB,
  manifest: PackManifest,
  hooks: InstallHooks,
  opts: InstallOptions = {},
): Promise<ActivePackInfo> {
  const batchSize = opts.batchSize ?? 1000;
  const now = Date.now();
  const version = manifest.packVersion;

  const existing = await db.packs.get(version);
  if (existing?.state === "active") throw new PackInstallError(`pack ${version} is already active`);
  if (existing) await purgePack(db, version);

  await db.packs.put({ packVersion: version, state: "staged", manifest, installedRows: 0, installedAt: now, updatedAt: now });

  let rowsDone = 0;
  for (let i = 0; i < manifest.chunks.length; i++) {
    const info = manifest.chunks[i];
    if (!info) throw new PackInstallError(`manifest chunk ${i} missing`);
    if (opts.failAfterChunks !== undefined && i >= opts.failAfterChunks) {
      await dropStaged(db, version, `aborted after ${i} of ${manifest.chunks.length} chunks`);
    }

    const rows = await decodeRows(await hooks.fetchChunk(info.file));
    if (rows.length !== info.rowCount) {
      await dropStaged(db, version, `chunk ${info.file} row count ${rows.length} != manifest ${info.rowCount}`);
    }
    const bad = rows.findIndex((r) => !isEntryRow(r) || r.packVersion !== version);
    if (bad >= 0) {
      await dropStaged(db, version, `chunk ${info.file} row ${bad} failed validation`);
    }

    for (let at = 0; at < rows.length; at += batchSize) {
      const slice = rows.slice(at, at + batchSize);
      const aliases = slice.flatMap(aliasRowsFor);
      await db.transaction("rw", [db.entries, db.aliases], async () => {
        await db.entries.bulkPut(slice);
        await db.aliases.bulkPut(aliases);
      });
      rowsDone += slice.length;
    }
    await db.packs.update(version, { installedRows: rowsDone, updatedAt: Date.now() });
    hooks.onProgress?.({ chunksDone: i + 1, chunksTotal: manifest.chunks.length, rowsDone, rowsTotal: manifest.entryCount });
  }

  if (rowsDone !== manifest.entryCount) {
    await dropStaged(db, version, `installed ${rowsDone} rows, manifest declares ${manifest.entryCount}`);
  }
  // read the rows back through the primary index before trusting them
  const indexed = await db.entries.where("packVersion").equals(version).count();
  if (indexed !== manifest.entryCount) {
    await dropStaged(db, version, `index holds ${indexed} rows, manifest declares ${manifest.entryCount}`);
  }

  const previous = await activePack(db);
  await db.transaction("rw", [db.packs, db.meta], async () => {
    await db.packs.update(version, { state: "active", updatedAt: Date.now() });
    if (previous) await db.packs.update(previous.packVersion, { state: "retired", updatedAt: Date.now() });
    await db.meta.put({
      key: META_KEY,
      activePackVersion: version,
      attribution: manifest.builtFrom,
      installedAt: now,
      compressedBytes: manifest.compressedBytes,
      entryCount: manifest.entryCount,
    });
  });

  if (previous && previous.packVersion !== version) await purgePack(db, previous.packVersion);

  return {
    packVersion: version,
    attribution: manifest.builtFrom,
    installedAt: now,
    compressedBytes: manifest.compressedBytes,
    entryCount: manifest.entryCount,
    headwordCount: manifest.headwordCount,
    license: manifest.builtFrom.license,
    licenseUrl: manifest.builtFrom.licenseUrl,
  };
}

/** `never` so a failed install cannot be read as a successful one. */
const dropStaged = async (db: DictionaryDB, version: string, why: string): Promise<never> => {
  await db.packs.update(version, { state: "failed", updatedAt: Date.now() });
  await purgePack(db, version);
  throw new PackInstallError(`activation failed (${why}); previous pack retained`);
};

export async function purgePack(db: DictionaryDB, version: string): Promise<void> {
  await db.transaction("rw", [db.packs, db.entries, db.aliases], async () => {
    await db.entries.where("packVersion").equals(version).delete();
    await db.aliases.where("packVersion").equals(version).delete();
    await db.packs.delete(version);
  });
}

export async function activePack(db: DictionaryDB): Promise<ActivePackInfo | null> {
  const row = await db.packs.where("state").equals("active").first();
  if (!row) return null;
  return {
    packVersion: row.packVersion,
    attribution: row.manifest.builtFrom,
    installedAt: row.installedAt,
    compressedBytes: row.manifest.compressedBytes,
    entryCount: row.manifest.entryCount,
    headwordCount: row.manifest.headwordCount,
    license: row.manifest.builtFrom.license,
    licenseUrl: row.manifest.builtFrom.licenseUrl,
  };
}
