/**
 * Build-time generator for the offline asset inventory. Run via npm scripts:
 *
 *   npm run offline:inventory   # write dist/offline-assets.json
 *   npm run offline:smoke       # assert Section 16 budgets
 *
 * Node cannot execute a .ts file directly, so both scripts go through
 * `vite-node`, which is already a devDependency. Run it with plain `node` and
 * the module loads but the entrypoint guard below does not fire: the process
 * exits 0 having written nothing, which is a silent no-op, not a failure.
 *
 * This file is Node-only and is never bundled for the browser: nothing under
 * src/ imports it, and ./offline-assets.ts (the browser-safe half) imports
 * nothing from here.
 *
 * WHY AN INVENTORY AT ALL
 * The service worker must not decide what to install from a hand-maintained
 * list that can drift from the bytes on disk. This generator measures the
 * bytes that actually exist, stamps a sha384 digest on each, and records the
 * pinned producer version. computeReadiness() then compares what the cache
 * holds against exactly this file, so a worker that precached the wrong or a
 * tampered byte sequence cannot produce the Ready-offline claim.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

import {
  BUDGET_BY_GROUP,
  DELIVERY_BUDGETS,
  INVENTORY_SCHEMA,
  type AssetFile,
  type AssetGroupId,
  type AssetKind,
  type Inventory,
  type InventoryGroup,
  type ProducerTrack,
} from "./offline-assets.ts";

// The app shell is produced by Track A, which owns the build config
// (Section 22.1). `ProducerTrack` includes "A", so this needs no cast.
const SHELL_PRODUCER: ProducerTrack = "A";

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist");

/**
 * Assets copied from node_modules into public/ at build-prep time (see
 * docs/offline-delivery.md for the exact copy commands and the byte totals).
 * Each entry names the group, the kind, the owning track, and how the
 * producer version is derived.
 *
 * NO pdfjs-dist/build/pdf.worker.mjs ROW, DELIBERATELY.
 * src/ui/reader/pdfEngine.ts loads the worker through Vite's
 * `import("pdfjs-dist/build/pdf.worker.mjs?worker")`, which emits it as its own
 * content-hashed chunk under /assets/. A hand-copied second copy at
 * /pdfjs/pdf.worker.mjs was precached for a while and cost 1.80 MiB raw /
 * 362 KiB gzip of bytes no code path ever loads. It is removed. The worker is
 * still precached — as the /assets/ chunk, classified `lazy-chunks` — so the
 * offline requirement is met with one copy instead of two.
 *
 * To go back to a self-hosted worker URL instead of `?worker`, delete nothing
 * here: re-add the row, re-copy the file, and drop the `?worker` import.
 */
const VENDOR_ASSETS: readonly {
  group: AssetGroupId;
  kind: AssetKind;
  producer: ProducerTrack;
  from: string;
  urlPrefix: string;
  pkg: string;
  /** true = one file; false = every file in the directory */
  single: boolean;
  /**
   * Version string reported for this group. Defaults to the npm package
   * version; set `version` for assets that are not an npm package (the
   * dictionary pack is a generated artifact, not a dependency).
   */
  version?: string;
}[] = [
  {
    // The offline dictionary pack. Precached because a learner reading offline
    // must still be able to look a word up: without it every lookup reports
    // "no pack", which is the app's whole reason for existing.
    group: "dictionary",
    kind: "dictionary",
    producer: "C",
    from: "public/dictionary",
    urlPrefix: "/dictionary",
    pkg: "Wiktionary CC BY-SA 4.0/GFDL via kaikki.org",
    version: "en-id-0.1.0",
    single: false,
  },
  {
    group: "pdfjs-cmaps",
    kind: "cmap",
    producer: "B",
    from: "public/pdfjs/cmaps",
    urlPrefix: "/pdfjs/cmaps",
    pkg: "pdfjs-dist",
    single: false,
  },
  {
    group: "pdfjs-standard-fonts",
    kind: "font",
    producer: "B",
    from: "public/pdfjs/standard_fonts",
    urlPrefix: "/pdfjs/standard_fonts",
    pkg: "pdfjs-dist",
    single: false,
  },
  {
    group: "inspector-wasm",
    kind: "wasm",
    producer: "E",
    from: "public/inspector/pdf_inspector_wasm_bg.wasm",
    urlPrefix: "/inspector/pdf_inspector_wasm_bg.wasm",
    pkg: "@firecrawl/pdf-inspector-wasm",
    single: true,
  },
  {
    group: "inspector-glue",
    kind: "wasm",
    producer: "E",
    from: "public/inspector/pdf_inspector_wasm.js",
    urlPrefix: "/inspector/pdf_inspector_wasm.js",
    pkg: "@firecrawl/pdf-inspector-wasm",
    single: true,
  },
];

const mimeByExt: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".bcmap": "application/octet-stream",
  ".ttf": "font/ttf",
  ".pfb": "application/octet-stream",
};

export function mimeFor(url: string): string {
  return mimeByExt[path.extname(url)] ?? "application/octet-stream";
}

const sha384 = (bytes: Buffer): string => `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

const gzipBytes = (bytes: Buffer): number => deflateSync(bytes, { level: 9 }).length;

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function pkgVersion(name: string): Promise<string> {
  const raw = await readFile(path.join(ROOT, "node_modules", name, "package.json"), "utf8");
  return `${name}@${(JSON.parse(raw) as { version: string }).version}`;
}

async function appVersion(): Promise<string> {
  const raw = await readFile(path.join(ROOT, "package.json"), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

/* ---------------------------------------------------------------- icons --- */

const ICON_SIZES: readonly { file: string; size: number; maskable: boolean }[] = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-maskable-512.png", size: 512, maskable: true },
];

const INK: readonly [number, number, number] = [0x1f, 0x2a, 0x56];
const PAPER: readonly [number, number, number] = [0xff, 0xff, 0xff];
const RIBBON: readonly [number, number, number] = [0xf2, 0xb0, 0x3c];

const pngChunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

/** Deterministic RGBA PNG. Written by hand so no image dependency is added. */
function encodePng(size: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Rounded-rectangle coverage, 3x3 supersampled, in unit coordinates. */
function roundedRectCoverage(x: number, y: number, w: number, h: number, r: number): number {
  let hits = 0;
  for (let sy = 0; sy < 3; sy += 1) {
    for (let sx = 0; sx < 3; sx += 1) {
      const px = x + (sx + 0.5) / 3;
      const py = y + (sy + 0.5) / 3;
      const cx = Math.min(Math.max(px, x + r), x + w - r);
      const cy = Math.min(Math.max(py, y + r), y + h - r);
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= r * r) hits += 1;
    }
  }
  return hits / 9;
}

/**
 * A book plate: indigo ground, four paper text lines, one amber ribbon.
 * Maskable variants drop the rounded corners and inset the motif into the
 * safe zone so platform masks cannot crop it.
 */
function drawIcon(size: number, maskable: boolean): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const put = (i: number, rgb: readonly [number, number, number], a: number): void => {
    const inv = 1 - a;
    for (let c = 0; c < 4; c += 1) {
      const src = c === 3 ? 255 : (rgb[c] ?? 0);
      rgba[i + c] = Math.round(src * a + (rgba[i + c] ?? 0) * inv);
    }
  };

  const plateInset = maskable ? 0 : size * 0.02;
  const plate = { x: plateInset, y: plateInset, w: size - plateInset * 2, h: size - plateInset * 2 };
  const radius = maskable ? 0 : size * 0.22;
  const motif = maskable ? 0.68 : 1;

  // Four text lines of decreasing length.
  const lines: readonly { top: number; height: number; width: number }[] = [
    { top: 0.3, height: 0.075, width: 0.5 },
    { top: 0.44, height: 0.075, width: 0.5 },
    { top: 0.58, height: 0.075, width: 0.36 },
  ];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const i = (y * size + x) * 4;
      put(i, INK, roundedRectCoverage(plate.x, plate.y, plate.w, plate.h, radius));

      const ribbon = { x: 0.63, y: 0.22, w: 0.11, h: 0.56 };
      const inRibbon =
        roundedRectCoverage(ribbon.x, ribbon.y, ribbon.w, ribbon.h, ribbon.w * 0.5) *
        (v > ribbon.y + ribbon.h - 0.09 && u > ribbon.x + ribbon.w * 0.5 - 0.09 ? 0 : 1);
      if (inRibbon > 0) put(i, RIBBON, inRibbon);

      for (const line of lines) {
        const box = {
          x: (0.5 - line.width * motif) / 2 + 0.11 * motif,
          y: line.top * motif + (1 - motif) * 0.5 - 0.055 * motif,
          w: line.width * motif,
          h: line.height * motif,
        };
        const a = roundedRectCoverage(box.x, box.y, box.w, box.h, box.h * 0.45);
        if (a > 0) put(i, PAPER, a);
      }
    }
  }
  return rgba;
}

/* --------------------------------------------------------- web manifest --- */

const MANIFEST = {
  name: "English Reading Companion",
  short_name: "Reading Companion",
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#1f2a56",
  description: "Read local books with a local dictionary, marks and review. Works offline.",
  orientation: "any",
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
} as const;

/* ----------------------------------------------------------- collection --- */

type Measured = { url: string; bytes: number; gz: number; sha: string };

async function measure(absPath: string, url: string): Promise<Measured> {
  const bytes = await readFile(absPath);
  return { url, bytes: bytes.length, gz: gzipBytes(bytes), sha: sha384(bytes) };
}

async function collect(): Promise<Inventory> {
  const version = await appVersion();
  const assets: AssetFile[] = [];
  const totalsByGroup = new Map<AssetGroupId, InventoryGroup>();

  const account = (file: AssetFile, gz: number): void => {
    assets.push(file);
    const prev = totalsByGroup.get(file.group);
    totalsByGroup.set(file.group, {
      group: file.group,
      files: (prev?.files ?? 0) + 1,
      bytes: (prev?.bytes ?? 0) + file.bytes,
      gzipBytes: (prev?.gzipBytes ?? 0) + gz,
    });
  };

  // Vendor assets: required. A PDF that cannot render or extract offline is
  // the difference between a reading app and a shell.
  for (const spec of VENDOR_ASSETS) {
    const abs = path.join(ROOT, spec.from);
    const producerVersion = spec.version ?? (await pkgVersion(spec.pkg));
    if (spec.single) {
      const m = await measure(abs, spec.urlPrefix);
      account(
        {
          id: `${spec.group}:${path.basename(spec.urlPrefix)}`,
          url: spec.urlPrefix,
          kind: spec.kind,
          producer: spec.producer,
          version: producerVersion,
          integrity: m.sha,
          bytes: m.bytes,
          required: true,
          group: spec.group,
        },
        m.gz,
      );
      continue;
    }
    const dir = abs;
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const url = `${spec.urlPrefix}/${name}`;
      const m = await measure(path.join(dir, name), url);
      account(
        {
          id: `${spec.group}:${name}`,
          url,
          kind: spec.kind,
          producer: spec.producer,
          version: producerVersion,
          integrity: m.sha,
          bytes: m.bytes,
          required: true,
          group: spec.group,
        },
        m.gz,
      );
    }
  }

  // Shell: index.html, web manifest, icons, and the content-hashed bundles.
  // All required. Readiness over these is what stops a bare HTML document
  // from ever being reported as offline-ready.
  const html = await readFile(path.join(DIST, "index.html"), "utf8");
  // The entry chunk is whatever index.html actually loads. Detecting it from
  // the HTML rather than from an "index-*" filename convention is what keeps
  // the Section 16 shell budget honest once the bundler emits lazy chunks
  // with unrelated names.
  const entryRefs = new Set(
    [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1] as string),
  );

  const shellFiles: { abs: string; url: string; hashed: boolean }[] = [
    { abs: path.join(DIST, "index.html"), url: "/index.html", hashed: false },
    { abs: path.join(DIST, "manifest.webmanifest"), url: "/manifest.webmanifest", hashed: false },
    ...ICON_SIZES.map((i) => ({ abs: path.join(DIST, "icons", i.file), url: `/icons/${i.file}`, hashed: false })),
  ];

  const bundleDir = path.join(DIST, "assets");
  if (await exists(bundleDir)) {
    for (const name of (await readdir(bundleDir)).sort()) {
      shellFiles.push({ abs: path.join(bundleDir, name), url: `/assets/${name}`, hashed: true });
    }
  }

  for (const file of shellFiles) {
    if (!(await exists(file.abs))) throw new Error(`missing shell asset: ${file.abs}`);
    const m = await measure(file.abs, file.url);
    // A hashed bundle that index.html does not reference is a lazily imported
    // format engine; index.html, the manifest, the icons and the referenced
    // entry assets are the shell.
    const isLazy = file.hashed && !entryRefs.has(file.url);
    account(
      {
        id: `${isLazy ? "lazy-chunk" : "shell"}:${path.basename(file.url)}`,
        url: file.url,
        kind: "shell",
        producer: SHELL_PRODUCER,
        // Content-hashed bundles are already versioned by their own URL, so
        // the digest prefix is the honest version. Everything else rides the
        // application version and is re-checked by integrity on every install.
        version: file.hashed ? `sha256:${m.sha.slice(7, 19)}` : version,
        integrity: m.sha,
        bytes: m.bytes,
        required: true,
        group: isLazy ? "lazy-chunks" : "shell",
      },
      m.gz,
    );
  }

  const groups = [...totalsByGroup.values()];
  return {
    schema: INVENTORY_SCHEMA,
    appVersion: version,
    groups,
    totals: {
      files: assets.length,
      bytes: assets.reduce((n, a) => n + a.bytes, 0),
      gzipBytes: groups.reduce((n, g) => n + g.gzipBytes, 0),
    },
    assets,
  };
}

/** Writes the generated icons and web manifest that a PWA install needs. */
async function emitShellExtras(): Promise<void> {
  await mkdir(path.join(DIST, "icons"), { recursive: true });
  for (const icon of ICON_SIZES) {
    await writeFile(path.join(DIST, "icons", icon.file), encodePng(icon.size, drawIcon(icon.size, icon.maskable)));
  }
  await writeFile(path.join(DIST, "manifest.webmanifest"), `${JSON.stringify(MANIFEST, null, 2)}\n`);
}

/* ----------------------------------------------------------------- CLI --- */

const fmt = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
};

function table(inventory: Inventory): string {
  const rows = inventory.groups.map((g) => {
    const budget = BUDGET_BY_GROUP[g.group];
    const limit = budget ? DELIVERY_BUDGETS[budget] : null;
    const verdict = limit === null ? "—" : g.gzipBytes <= limit ? "ok" : "OVER";
    return `  ${g.group.padEnd(24)} ${String(g.files).padStart(4)} files  ${fmt(g.bytes).padStart(11)} raw  ${fmt(g.gzipBytes).padStart(11)} gzip  budget=${budget ?? "—"} ${verdict}`;
  });
  return [
    `offline inventory ${inventory.appVersion} — ${inventory.totals.files} files`,
    ...rows,
    `  ${"TOTAL".padEnd(24)} ${String(inventory.totals.files).padStart(4)} files  ${fmt(inventory.totals.bytes).padStart(11)} raw  ${fmt(inventory.totals.gzipBytes).padStart(11)} gzip  budget=offlineInstall ${inventory.totals.gzipBytes <= DELIVERY_BUDGETS.offlineInstall ? "ok" : "OVER"}`,
  ].join("\n");
}

function assertBudgets(inventory: Inventory): void {
  const failures: string[] = [];
  for (const group of inventory.groups) {
    const budget = BUDGET_BY_GROUP[group.group];
    if (budget === null) continue;
    const limit = DELIVERY_BUDGETS[budget];
    if (group.gzipBytes > limit) {
      failures.push(`${group.group}: ${fmt(group.gzipBytes)} gzip exceeds ${budget} (${fmt(limit)})`);
    }
  }
  if (inventory.totals.gzipBytes > DELIVERY_BUDGETS.offlineInstall) {
    failures.push(`offline install ${fmt(inventory.totals.gzipBytes)} gzip exceeds ${fmt(DELIVERY_BUDGETS.offlineInstall)}`);
  }
  if (failures.length > 0) throw new Error(`Section 16 delivery budget exceeded:\n  ${failures.join("\n  ")}`);
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? "inventory";
  if (!(await exists(DIST))) {
    process.stderr.write("dist/ is missing — run `npm run build` first.\n");
    return 1;
  }

  if (command === "inventory") {
    await emitShellExtras();
    const inventory = await collect();
    assertBudgets(inventory);
    await writeFile(path.join(DIST, "offline-assets.json"), `${JSON.stringify(inventory, null, 2)}\n`);
    process.stdout.write(`${table(inventory)}\nwrote dist/offline-assets.json\n`);
    return 0;
  }

  if (command === "smoke") {
    const inventory = await collect();
    assertBudgets(inventory);
    const missing: string[] = [];
    for (const asset of inventory.assets) {
      const abs = path.join(DIST, asset.url.replace(/^\//, ""));
      if (!(await exists(abs))) missing.push(asset.url);
    }
    if (missing.length > 0) {
      process.stderr.write(`precached URLs with no file in dist/:\n  ${missing.join("\n  ")}\n`);
      return 1;
    }
    const onDisk = await readFile(path.join(DIST, "offline-assets.json"), "utf8");
    const shipped = JSON.parse(onDisk) as Inventory;
    const drift = shipped.assets.filter((a) => {
      const fresh = inventory.assets.find((b) => b.url === a.url);
      return !fresh || fresh.integrity !== a.integrity;
    });
    if (drift.length > 0) {
      process.stderr.write(`inventory is stale for: ${drift.map((a) => a.url).join(", ")}\n`);
      return 1;
    }
    process.stdout.write(`${table(inventory)}\nsmoke: ${inventory.assets.length} precached URLs resolve, digests match, budgets hold\n`);
    return 0;
  }

  process.stderr.write(`unknown command: ${command} (expected: inventory | smoke)\n`);
  return 2;
}

// vite-node rewrites process.argv[1] to its own CLI shim, so comparing it to
// this file's basename is false and main() would silently never run. Match on
// this module's own path instead, which vite-node preserves in import.meta.url.
const invokedDirectly = import.meta.url.endsWith("offline-assets.build.ts");
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}

export { collect, emitShellExtras, table, assertBudgets };