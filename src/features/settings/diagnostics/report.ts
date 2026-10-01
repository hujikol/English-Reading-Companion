/**
 * Local issue-report builder. Section 21: app/parser versions, cache sizes,
 * capability results, anonymized timings; user reviews before copying.
 * Section 22.5 H1: "Diagnostics excludes filenames/text/hashes/secrets".
 *
 * Security model: two independent controls.
 *  1. Allow-list. Fields are copied out of a fixed key list. Properties the
 *     caller invented — a document record merged into the input, say — are
 *     dropped even when they are in the input object.
 *  2. Value scrubbing. Anything that survives the allow-list is still scanned
 *     for filenames, digests and secret markers, because a legitimate field can
 *     carry leaked content in its value.
 */

import type { Capabilities } from "../../../contracts/index.ts";
import type { InstallPhase } from "../../../pwa/install.ts";
import type { Readiness } from "../../../pwa/manifest.ts";
import type { Category } from "../storage/quota.ts";

export type DiagnosticsInput = {
  appVersion: string;
  contractVersion: string;
  databaseVersion: number;
  parserVersion: string;
  userAgent: string;
  persistentStorage: "granted" | "denied" | "unknown";
  capabilities: Partial<Capabilities>;
  readiness: Readiness;
  installPhase: InstallPhase;
  storage: { used: number; quota: number };
  categories: readonly { category: Category; bytes: number; canFree: boolean }[];
  /** Dynamic key space, so keys are scrubbed as well as values. */
  timingsMs?: Record<string, number>;
};

export type DiagnosticsReport = {
  appVersion: string;
  contractVersion: string;
  databaseVersion: number;
  parserVersion: string;
  platform: { userAgent: string; persistentStorage: string };
  capabilities: Record<string, string>;
  offline: { phase: string; readyOffline: boolean; missingAssets: number; mismatchedAssets: number };
  storage: { used: number; quota: number; byCategory: { category: string; bytes: number; canFree: boolean }[] };
  timingsMs: Record<string, number>;
};

const SENSITIVE_WORDS = new Set([
  "filename", "name", "originalname", "title", "path", "quote", "text", "content", "hash",
  "checksum", "integrity", "digest", "password", "token", "secret", "key", "api", "apikey",
  "email", "author", "url", "href", "note", "book", "body", "excerpt", "snippet", "locale",
]);

/** camelCase-aware word test, so `positionedText` is not read as "text". */
const isSensitiveKey = (key: string): boolean =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .some((word) => SENSITIVE_WORDS.has(word.toLowerCase()));

/** File extensions, subresource-integrity digests, and long opaque tokens. */
const SENSITIVE_VALUE =
  /(?:\b[A-Za-z0-9_-]+\.(?:pdf|epub|txt|md)\b)|(?:sha(?:256|384|512)-[A-Za-z0-9+/=]{8,})|(?:\b[A-Fa-f0-9]{32,}\b)|(?:\b[A-Za-z0-9+/_-]{48,}={0,2}\b)/i;

const scrub = (value: string): string => (SENSITIVE_VALUE.test(value) ? "[redacted]" : value);

const CAPABILITY_KEYS = ["semantic", "password", "ocr", "positionedText"] as const;

export function buildDiagnosticsReport(input: DiagnosticsInput): DiagnosticsReport {
  const capabilities: Record<string, string> = {};
  for (const key of CAPABILITY_KEYS) {
    const value = input.capabilities[key];
    if (value === undefined) continue;
    capabilities[key] = typeof value === "boolean" ? String(value) : scrub(String(value));
  }

  const timingsMs: Record<string, number> = {};
  for (const [key, value] of Object.entries(input.timingsMs ?? {})) {
    if (isSensitiveKey(key)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    // Integer ms: coarse enough not to be a fingerprint, fine enough to compare runs.
    timingsMs[key.slice(0, 40)] = Math.round(value);
  }

  return {
    appVersion: scrub(input.appVersion.slice(0, 32)),
    contractVersion: scrub(input.contractVersion.slice(0, 32)),
    databaseVersion: input.databaseVersion,
    parserVersion: scrub(input.parserVersion.slice(0, 32)),
    platform: { userAgent: input.userAgent.slice(0, 200), persistentStorage: input.persistentStorage },
    capabilities,
    offline: {
      phase: input.installPhase,
      readyOffline: input.readiness.readyOffline,
      missingAssets: input.readiness.missing.length,
      mismatchedAssets: input.readiness.mismatched.length + input.readiness.unverified.length,
    },
    storage: {
      used: input.storage.used,
      quota: input.storage.quota,
      byCategory: input.categories.map((c) => ({
        category: c.category,
        bytes: c.bytes,
        canFree: c.canFree,
      })),
    },
    timingsMs,
  };
}

/** Plain text for the copy button. */
export function formatDiagnostics(report: DiagnosticsReport): string {
  return [
    `app: ${report.appVersion}  contract: ${report.contractVersion}  db: v${report.databaseVersion}  parser: ${report.parserVersion}`,
    `platform: ${report.platform.userAgent}`,
    `persistent storage: ${report.platform.persistentStorage}`,
    `offline: ${report.offline.phase} (ready=${report.offline.readyOffline}, missing=${report.offline.missingAssets}, mismatched=${report.offline.mismatchedAssets})`,
    `storage: ${report.storage.used} / ${report.storage.quota} bytes`,
    ...report.storage.byCategory.map(
      (c) => `  ${c.category}: ${c.bytes} bytes${c.canFree ? " (can free)" : " (cannot free user data)"}`,
    ),
    ...Object.entries(report.capabilities).map(([k, v]) => `capability ${k}: ${v}`),
    ...Object.entries(report.timingsMs).map(([k, v]) => `timing ${k}: ${v} ms`),
  ].join("\n");
}