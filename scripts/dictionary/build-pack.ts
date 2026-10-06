/**
 * Dictionary pack build.
 *
 *   node --experimental-strip-types scripts/dictionary/build-pack.ts [config.json]
 *
 * Default config: `config.json` next to this file. It names the pinned source
 * file and its expected sha256. The real licensed artifact is not in the repo —
 * download it, verify the hash, and only then run against it.
 *
 * Deterministic: same source bytes + same config in, same pack out. No
 * timestamps, no host paths, no random ids anywhere in the output.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPack,
  gunzip,
  isEntryRow,
  PackBuildError,
  serializeManifest,
  sha256Hex,
  type BuiltPack,
} from "../../src/features/dictionary/pack.ts";

export type BuildConfig = {
  /** pinned source artifact */
  source: string;
  /** sha256 of the source file, lowercase hex. Verified before parsing. */
  sourceSha256: string;
  packVersion: string;
  sourceUrl: string;
  sourceRevision: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  outDir: string;
  /** rows per chunk */
  chunkRows?: number;
};

const HERE = dirname(fileURLToPath(import.meta.url));

export async function loadConfig(path: string): Promise<BuildConfig> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Partial<BuildConfig>;
  const need = ["source", "sourceSha256", "packVersion", "sourceUrl", "sourceRevision", "license", "licenseUrl", "attribution", "outDir"] as const;
  for (const k of need) {
    if (typeof raw[k] !== "string" || raw[k] === "") {
      throw new Error(`config ${path}: missing required string "${k}"`);
    }
  }
  // ponytail: relative paths resolve against the config file, not process.cwd().
  // noUncheckedIndexedAccess widens these back to `string | undefined`; the loop
  // above proved each is a non-empty string, so narrow once instead of casting
  // per field.
  // upgrade: if the pack build is ever invoked from another working directory,
  // re-verify this holds before trusting the resolved paths.
  const { source, outDir } = raw as Record<(typeof need)[number], string>;
  return { ...(raw as BuildConfig), source: resolve(dirname(path), source), outDir: resolve(dirname(path), outDir) };
}

/** Full validation pass over built output. A pack that fails this is never installed. */
export function validatePack(pack: BuiltPack): void {
  const { manifest, chunks } = pack;
  if (manifest.entryCount === 0) throw new Error("manifest reports zero entries");
  if (manifest.chunks.length !== chunks.length) throw new Error("manifest chunk list does not match emitted chunks");
  if (manifest.senseCount > manifest.entryCount) throw new Error("more senses than rows");
  if (manifest.compressedBytes >= manifest.rawBytes) throw new Error("compressed output is not smaller than raw output");
  let rows = 0;
  for (const c of chunks) {
    const info = manifest.chunks.find((i) => i.file === c.file);
    if (!info) throw new Error(`chunk ${c.file} missing from manifest`);
    if (info.compressedBytes !== c.bytes.length) throw new Error(`chunk ${c.file} size disagrees with manifest`);
    if (c.bytes[0] !== 0x1f || c.bytes[1] !== 0x8b) throw new Error(`chunk ${c.file} is not gzip`);
    rows += info.rowCount;
  }
  if (rows !== manifest.entryCount) throw new Error("manifest entryCount does not match chunk row counts");
}

export type BuildReport = {
  packVersion: string;
  outDir: string;
  manifestPath: string;
  entryCount: number;
  headwordCount: number;
  senseCount: number;
  rawBytes: number;
  compressedBytes: number;
  files: { file: string; rawBytes: number; compressedBytes: number; rowCount: number }[];
};

export async function buildFromConfig(config: BuildConfig): Promise<BuildReport> {
  const sourceBytes = await readFile(config.source);
  const actual = await sha256Hex(sourceBytes);
  if (actual !== config.sourceSha256.toLowerCase()) {
    throw new Error(`source checksum mismatch: expected ${config.sourceSha256}, got ${actual}`);
  }

  const pack = await buildPack(new TextDecoder().decode(sourceBytes), {
    packVersion: config.packVersion,
    sourceUrl: config.sourceUrl,
    sourceRevision: config.sourceRevision,
    license: config.license,
    licenseUrl: config.licenseUrl,
    attribution: config.attribution,
    ...(config.chunkRows === undefined ? {} : { chunkRows: config.chunkRows }),
  });
  validatePack(pack);

  // re-parse the emitted payload: what we ship is what we validated
  for (const c of pack.chunks) {
    const payload = JSON.parse(new TextDecoder().decode(await gunzip(c.bytes))) as { rows: unknown[] };
    const bad = payload.rows.findIndex((r) => !isEntryRow(r) || r.packVersion !== config.packVersion);
    if (bad >= 0) throw new Error(`chunk ${c.file} row ${bad} failed validation`);
  }

  await mkdir(config.outDir, { recursive: true });
  for (const c of pack.chunks) await writeFile(join(config.outDir, c.file), c.bytes);
  const manifestPath = join(config.outDir, "manifest.json");
  await writeFile(manifestPath, serializeManifest(pack.manifest));

  return {
    packVersion: pack.manifest.packVersion,
    outDir: config.outDir,
    manifestPath,
    entryCount: pack.manifest.entryCount,
    headwordCount: pack.manifest.headwordCount,
    senseCount: pack.manifest.senseCount,
    rawBytes: pack.manifest.rawBytes,
    compressedBytes: pack.manifest.compressedBytes,
    files: pack.manifest.chunks.map((c) => ({
      file: c.file,
      rawBytes: c.rawBytes,
      compressedBytes: c.compressedBytes,
      rowCount: c.rowCount,
    })),
  };
}

// Compare against this module's own path, not process.argv[1]: vite-node (and
// tsx) rewrite argv[1] to their CLI shim, which makes the argv comparison false
// and the whole build a silent no-op that still exits 0.
const invokedDirectly = import.meta.url.endsWith("build-pack.ts");
if (invokedDirectly) {
  const configPath = process.argv[2] ?? join(HERE, "config.json");
  try {
    const report = await buildFromConfig(await loadConfig(configPath));
    const mib = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MiB`;
    console.log(`pack ${report.packVersion} -> ${report.outDir}`);
    console.log(`  headwords ${report.headwordCount}  rows ${report.entryCount}  senses ${report.senseCount}`);
    console.log(`  raw ${mib(report.rawBytes)}  gzip ${mib(report.compressedBytes)}`);
    for (const f of report.files) console.log(`  ${f.file}  ${f.rowCount} rows  ${f.rawBytes} -> ${f.compressedBytes} bytes`);
    console.log(`  manifest ${report.manifestPath}`);
    if (report.compressedBytes > 10 * 1024 * 1024) {
      // IDEA.md section 9: transparent, never a silent truncation of meanings.
      console.warn("WARNING: pack exceeds the 10 MiB compressed target — offer an optional download, do not ship truncated senses.");
    }
  } catch (e) {
    console.error(e instanceof PackBuildError || e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
