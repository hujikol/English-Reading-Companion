/**
 * Offline asset manifest and readiness. Section 19: "explicitly install PDF
 * worker, inspector WASM when enabled, fonts/CMaps required by the pinned
 * build, and the selected dictionary pack before showing Ready offline".
 *
 * Ready offline is a claim about installed+verified+version-matched assets,
 * never about shell caching.
 */

export type ProducerTrack = "B" | "C" | "D" | "E";

export type AssetKind = "shell" | "pdf-worker" | "wasm" | "font" | "cmap" | "dictionary";

export type AssetId = string;

/** One required-or-optional offline asset, as declared by its producing track. */
export type AssetEntry = {
  id: AssetId;
  /** Cache key / URL. Relative to the app origin. */
  url: string;
  kind: AssetKind;
  producer: ProducerTrack;
  /** Producer-owned version. Bump on byte changes; readiness compares it. */
  version: string;
  /** Subresource-integrity string, e.g. "sha384-...". */
  integrity: string;
  bytes: number;
  /** Optional packs (unused dictionaries) never block Ready offline. */
  required: boolean;
};

export type AssetManifest = { appVersion: string; assets: readonly AssetEntry[] };

/** What the cache layer actually holds for an asset. */
export type InstalledAsset = {
  id: AssetId;
  version: string;
  integrity: string;
  /** Digest recomputed from stored bytes and matched against the manifest. */
  verified: boolean;
};

export type Readiness = {
  readyOffline: boolean;
  /** required, not installed at all */
  missing: readonly AssetId[];
  /** required, installed but version or integrity differs */
  mismatched: readonly AssetId[];
  /** required, matching version but digest not verified */
  unverified: readonly AssetId[];
  requiredCount: number;
};

/**
 * Ready offline iff every required asset is installed, verified and at the
 * manifest version. An empty required set is never ready: shell caching alone
 * must not produce the claim.
 */
export function computeReadiness(
  manifest: AssetManifest,
  installed: readonly InstalledAsset[],
): Readiness {
  const byId = new Map(installed.map((a) => [a.id, a]));
  const missing: AssetId[] = [];
  const mismatched: AssetId[] = [];
  const unverified: AssetId[] = [];
  let requiredCount = 0;

  for (const entry of manifest.assets) {
    if (!entry.required) continue;
    requiredCount += 1;
    const got = byId.get(entry.id);
    if (!got) {
      missing.push(entry.id);
      continue;
    }
    if (got.version !== entry.version || got.integrity !== entry.integrity) {
      mismatched.push(entry.id);
      continue;
    }
    if (!got.verified) unverified.push(entry.id);
  }

  const readyOffline =
    requiredCount > 0 && missing.length === 0 && mismatched.length === 0 && unverified.length === 0;
  return { readyOffline, missing, mismatched, unverified, requiredCount };
}