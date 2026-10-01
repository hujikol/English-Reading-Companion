/**
 * Quota recovery and storage accounting. Section 13: evict derived caches
 * first, retry once, otherwise keep the reading session temporary. Never
 * delete vocabulary, marks, explanations, bookmarks or originals.
 *
 * Eviction targets come from A's durability contract, never from a local list,
 * so a new `user` table cannot become evictable by omission here.
 */

import { DURABILITY, isEvictable, type TableName } from "../../../contracts/index.ts";

export type Category =
  | "originals"
  | "reading-data"
  | "derived-pages"
  | "ai-cache"
  | "dictionary"
  | "app-shell";

export type TableSize = { table: TableName; bytes: number; category: Category };

export type StorageEstimate = { usage: number; quota: number };

/** Largest derived tables first; frees the most bytes per unit of work. */
export function planEviction(sizes: readonly TableSize[]): TableName[] {
  return sizes
    .filter((s) => isEvictable(s.table))
    .sort((a, b) => b.bytes - a.bytes)
    .map((s) => s.table);
}

/** Derived bytes still held. Zero means eviction cannot help; user data is off-limits. */
export function derivedBytes(sizes: readonly TableSize[]): number {
  return sizes.filter((s) => isEvictable(s.table)).reduce((n, s) => n + s.bytes, 0);
}

export type RecoveryOutcome =
  | { status: "ok" }
  | { status: "ok-after-eviction"; evicted: TableName[]; freedBytes: number }
  | { status: "temporary-session"; evicted: TableName[]; freedBytes: number };

const isQuotaError = (e: unknown): boolean =>
  e instanceof DOMException &&
  (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED");

/**
 * Runs `op`; on a quota error evicts derived tables and retries exactly once.
 * `evict` receives only tables A marked evictable, so a bug elsewhere cannot
 * widen the blast radius.
 */
export async function recoverFromQuota<T>(
  op: () => Promise<T>,
  sizes: readonly TableSize[],
  evict: (tables: readonly TableName[]) => Promise<void>,
): Promise<{ value: T; outcome: RecoveryOutcome }> {
  try {
    return { value: await op(), outcome: { status: "ok" } };
  } catch (e) {
    if (!isQuotaError(e)) throw e;
    const plan = planEviction(sizes);
    const freedBytes = derivedBytes(sizes);
    if (plan.length === 0) return { value: undefined as T, outcome: { status: "temporary-session", evicted: [], freedBytes: 0 } };
    await evict(plan);
    try {
      return {
        value: await op(),
        outcome: { status: "ok-after-eviction", evicted: plan, freedBytes },
      };
    } catch (retryError) {
      // Still failing: keep the session temporary instead of touching user data.
      if (!isQuotaError(retryError)) throw retryError;
      return { value: undefined as T, outcome: { status: "temporary-session", evicted: plan, freedBytes } };
    }
  }
}

export type StorageRow = {
  category: Category;
  bytes: number;
  /** user data can be removed only by an explicit, per-item user action */
  canFree: boolean;
  evictable: boolean;
};

const CATEGORY_TABLE: Partial<Record<Category, readonly TableName[]>> = {
  originals: ["documents", "assets"],
  "reading-data": ["progress", "bookmarks", "marks", "vocabulary", "occurrences", "reviewCards", "reviewEvents", "explanations", "settings"],
  "derived-pages": ["semanticPages"],
  "ai-cache": ["aiCache"],
};

/** Aggregate table sizes into per-category rows. Derived first so users see what can be freed. */
export function breakdownByCategory(sizes: readonly TableSize[]): StorageRow[] {
  const rows = new Map<Category, StorageRow>();
  const add = (category: Category, bytes: number, evictable: boolean): void => {
    const prev = rows.get(category);
    rows.set(category, {
      category,
      bytes: (prev?.bytes ?? 0) + bytes,
      canFree: evictable,
      evictable,
    });
  };
  for (const s of sizes) add(categoryOf(s.table), s.bytes, isEvictable(s.table));
  return [...rows.values()].sort((a, b) => {
    if (a.evictable !== b.evictable) return a.evictable ? -1 : 1;
    return b.bytes - a.bytes;
  });
}

export function categoryOf(table: TableName): Category {
  for (const [category, tables] of Object.entries(CATEGORY_TABLE)) {
    if (tables.includes(table)) return category as Category;
  }
  // ponytail: v1 buckets cover all 13 tables; extend the map when a table is added.
  return "app-shell";
}

const fmt = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export type StorageReport = {
  lines: readonly string[];
  used: string;
  total: string;
  /** Only derived categories carry a free action; user data never does. */
  freeableBytes: number;
};

/**
 * Human-readable storage breakdown. Every user-data line is labelled
 * "cannot free" so freeing space can never silently take a learner's marks.
 */
export function buildStorageReport(
  estimate: StorageEstimate,
  sizes: readonly TableSize[],
  shellBytes = 0,
  dictionaryBytes = 0,
): StorageReport {
  const rows = breakdownByCategory(sizes).filter((r) => r.bytes > 0);
  const lines = rows.map((r) =>
    r.evictable
      ? `${r.category}: ${fmt(r.bytes)} — can free`
      : `${r.category}: ${fmt(r.bytes)} — cannot free user data`,
  );
  if (dictionaryBytes > 0) {
    lines.push(`dictionary: ${fmt(dictionaryBytes)} — can free (removes lookup, keeps progress)`);
  }
  if (shellBytes > 0) lines.push(`app-shell: ${fmt(shellBytes)} — can free (requires reinstall to read offline)`);
  return {
    lines,
    used: fmt(estimate.usage),
    total: fmt(estimate.quota),
    freeableBytes: derivedBytes(sizes) + dictionaryBytes,
  };
}

export { DURABILITY, isEvictable };