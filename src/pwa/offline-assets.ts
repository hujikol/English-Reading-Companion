/**
 * Offline asset declaration and accounting. Sections 19 (delivery) and 16
 * (performance budgets).
 *
 * WHAT THIS FILE OWNS
 *   - the list of assets that must be installed before the app may say
 *     "Ready offline", with the byte and digest bookkeeping around them;
 *   - the mapping from a generated build inventory to the AssetManifest shape
 *     that the existing readiness logic already consumes.
 *
 * WHAT THIS FILE DOES NOT OWN
 *   - the readiness decision: computeReadiness() in ./manifest.ts;
 *   - the install/update state machine: reduceInstall() in ./install.ts;
 *   - storage recovery: recoverFromQuota() in ../features/settings/storage/quota.ts.
 * Those are tested logic. This module only produces their inputs, so a claim
 * of "Ready offline" can never be raised by shell caching alone.
 *
 * This module is deliberately free of node imports: it is bundled for the
 * browser by ./sw-registration.ts. The Node-side generator that turns files
 * into an inventory is ./offline-assets.build.ts.
 */

import type { AssetEntry, AssetKind, AssetManifest, ProducerTrack } from "./manifest.ts";

// Re-exported so the build-time generator and the tests can name these types
// without importing ./manifest.ts directly. The declarations themselves stay
// canonical in manifest.ts, which this track does not edit.
export type { AssetKind, ProducerTrack };

/** Bumped when the inventory file shape changes; the SW refuses a mismatch. */
export const INVENTORY_SCHEMA = 1;

/** Served from the build output, not from public/: it describes the build. */
export const INVENTORY_URL = "/offline-assets.json";

/** Root scope so one worker controls the whole app shell and asset tree. */
export const SW_URL = "/sw.js";
export const SW_SCOPE = "/";

/**
 * Where each precached byte range comes from. Grouping exists so the delivery
 * budget in Section 16 ("lazy PDF engine", "inspector WASM and glue") can be
 * checked per line item instead of against one opaque total.
 */
export type AssetGroupId =
  | "shell"
  | "lazy-chunks"
  | "pdfjs-worker"
  | "pdfjs-cmaps"
  | "pdfjs-standard-fonts"
  | "inspector-wasm"
  | "inspector-glue"
  | "dictionary";

/**
 * One precached file. Structurally an AssetEntry plus the group and the
 * already-declared URL, so nothing has to be re-derived at install time.
 */
export type AssetFile = {
  id: string;
  /** Same-origin path the service worker fetches and caches. */
  url: string;
  kind: AssetKind;
  producer: ProducerTrack;
  /**
   * Producer-owned version. Vendor groups carry the pinned package version
   * (`pkg@1.2.3`); content-hashed shell bundles carry the short digest of
   * their own bytes, because for those the URL already is the version.
   */
  version: string;
  /** Subresource-integrity string, "sha384-<base64>". */
  integrity: string;
  bytes: number;
  required: boolean;
  group: AssetGroupId;
};

export type InventoryGroup = {
  group: AssetGroupId;
  files: number;
  bytes: number;
  /** Bytes actually transferred when the host serves precompressed. */
  gzipBytes: number;
};

export type Inventory = {
  schema: number;
  appVersion: string;
  /** Group and total transfer figures, for Section 16 budget checks. */
  groups: readonly InventoryGroup[];
  totals: { files: number; bytes: number; gzipBytes: number };
  assets: readonly AssetFile[];
};

/**
 * Section 16 delivery budgets, verbatim from the spec table, in bytes.
 * Asserted by the build smoke check and by tests/pwa/offline.test.ts so a
 * silent 3x growth in a vendor asset cannot pass unnoticed.
 */
export const DELIVERY_BUDGETS = {
  /** "Initial app shell JavaScript: at most 250 KiB gzip" */
  shellJsGzip: 250 * 1024,
  /** "Total shell transfer including CSS/icons: at most 500 KiB compressed" */
  shellTransfer: 500 * 1024,
  /** "Lazy PDF engine and worker: target at most 1.5 MiB compressed" */
  pdfEngine: 1.5 * 1024 * 1024,
  /** "Inspector WASM and glue: provisional target at most 5 MiB compressed" */
  inspectorWasm: 5 * 1024 * 1024,
  /** "Default offline asset installation: at most 20 MiB compressed" */
  offlineInstall: 20 * 1024 * 1024,
} as const;

/**
 * Section 16 budget mapping, verbatim from the spec wording.
 *
 * - "Initial app shell JavaScript: at most 250 KiB gzip, EXCLUDING LAZY FORMAT
 *   ENGINES" and "Total shell transfer including CSS/icons: at most 500 KiB
 *   compressed" -> `shell`, which is the entry chunk, its CSS, the manifest
 *   and the icons. Never the lazy chunks.
 * - "Lazy PDF engine and worker: target at most 1.5 MiB compressed" ->
 *   `lazy-chunks` (whatever the bundler emitted outside the entry point)
 *   plus `pdfjs-worker` (the self-hosted worker copy).
 * - Section 16 gives fonts and CMaps no budget line of their own; they are
 *   required for offline reading (Section 19) and are therefore charged to
 *   the only line they can honestly be charged to,
 *   "Default offline asset installation: at most 20 MiB compressed". They are
 *   deliberately NOT folded into the 1.5 MiB engine budget, which the spec
 *   scopes to "engine and worker".
 * - "Inspector WASM and glue: provisional target at most 5 MiB compressed" ->
 *   the two inspector groups.
 */
export const BUDGET_BY_GROUP: Readonly<Record<AssetGroupId, keyof typeof DELIVERY_BUDGETS | null>> = {
  shell: "shellTransfer",
  "lazy-chunks": "pdfEngine",
  "pdfjs-worker": "pdfEngine",
  "pdfjs-cmaps": "offlineInstall",
  "pdfjs-standard-fonts": "offlineInstall",
  "inspector-wasm": "inspectorWasm",
  "inspector-glue": "inspectorWasm",
  // The dictionary pack is charged to the total-install budget, not the engine
  // budget: it is a content pack, not part of the PDF pipeline.
  dictionary: "offlineInstall",
};

/** Sum of raw bytes. Reported honestly; transfer size is tracked separately. */
export function totalBytes(files: readonly { bytes: number }[]): number {
  return files.reduce((n, f) => n + f.bytes, 0);
}

/** The subset that gates the Ready-offline claim. */
export function requiredFiles(inventory: Inventory): readonly AssetFile[] {
  return inventory.assets.filter((a) => a.required);
}

/**
 * Adapt a generated inventory to the manifest the existing readiness logic
 * already understands. No second readiness rule is introduced here: the
 * returned object is fed straight to computeReadiness().
 */
export function toAssetManifest(inventory: Inventory): AssetManifest {
  const assets: AssetEntry[] = inventory.assets.map((a) => ({
    id: a.id,
    url: a.url,
    kind: a.kind,
    producer: a.producer,
    version: a.version,
    integrity: a.integrity,
    bytes: a.bytes,
    required: a.required,
  }));
  return { appVersion: inventory.appVersion, assets };
}

/** True only when every declared asset carries bytes and a sha384 digest. */
export function isWellFormed(inventory: Inventory): boolean {
  if (inventory.schema !== INVENTORY_SCHEMA) return false;
  if (inventory.assets.length === 0) return false;
  return inventory.assets.every(
    (a) => a.bytes > 0 && /^sha384-[A-Za-z0-9+/]+={0,2}$/.test(a.integrity) && a.url.startsWith("/"),
  );
}

/**
 * Structural validation of an inventory that arrived over the network. The
 * service worker treats a failure here exactly like a failed install rather
 * than precaching an unverified list.
 */
export function parseInventory(value: unknown): Inventory | null {
  const raw = value as Partial<Inventory> | null;
  if (raw === null || typeof raw !== "object") return null;
  if (typeof raw.schema !== "number" || typeof raw.appVersion !== "string") return null;
  if (!Array.isArray(raw.assets) || !Array.isArray(raw.groups)) return null;
  const groups = raw.groups as InventoryGroup[];
  const totals = raw.totals;
  if (typeof totals !== "object" || totals === null) return null;
  const inventory: Inventory = {
    schema: raw.schema,
    appVersion: raw.appVersion,
    groups,
    totals: { files: totals.files ?? 0, bytes: totals.bytes ?? 0, gzipBytes: totals.gzipBytes ?? 0 },
    assets: raw.assets as AssetFile[],
  };
  return isWellFormed(inventory) ? inventory : null;
}