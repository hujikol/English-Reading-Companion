import { describe, expect, it } from "vitest";
import { DURABILITY, type TableName } from "../../src/contracts/index.ts";
import {
  breakdownByCategory,
  buildStorageReport,
  derivedBytes,
  planEviction,
  recoverFromQuota,
  type TableSize,
} from "../../src/features/settings/storage/quota.ts";

const USER_TABLES = Object.entries(DURABILITY)
  .filter(([, tier]) => tier === "user")
  .map(([name]) => name) as TableName[];

const size = (table: TableName, bytes: number): TableSize => ({
  table,
  bytes,
  category: "reading-data",
});

const SIZES: TableSize[] = [
  size("documents", 5_000_000),
  size("assets", 3_000_000),
  size("vocabulary", 40_000),
  size("marks", 30_000),
  size("bookmarks", 2_000),
  size("explanations", 8_000),
  size("progress", 1_000),
  size("semanticPages", 900_000),
  size("aiCache", 100_000),
];

const quotaError = (): Promise<never> =>
  Promise.reject(new DOMException("quota", "QuotaExceededError"));

/** Every write attempt, so "did we touch user data" is answered by observation. */
function spy() {
  const touched: TableName[] = [];
  return {
    touched,
    evict: async (tables: readonly TableName[]) => {
      touched.push(...tables);
    },
  };
}

describe("quota recovery", () => {
  it("passes through untouched when the first attempt succeeds", async () => {
    const s = spy();
    const { value, outcome } = await recoverFromQuota(async () => "ok", SIZES, s.evict);
    expect(value).toBe("ok");
    expect(outcome.status).toBe("ok");
    expect(s.touched).toEqual([]);
  });

  it("evicts only derived tables on a quota error and retries once", async () => {
    const s = spy();
    let calls = 0;
    const { value, outcome } = await recoverFromQuota(
      async () => {
        calls += 1;
        if (calls === 1) return quotaError();
        return "saved";
      },
      SIZES,
      s.evict,
    );
    expect(value).toBe("saved");
    expect(calls).toBe(2);
    expect(outcome).toMatchObject({ status: "ok-after-eviction", freedBytes: 1_000_000 });
    expect([...s.touched].sort()).toEqual(["aiCache", "semanticPages"]);
    for (const t of s.touched) expect(DURABILITY[t]).toBe("derived");
  });

  it("never touches user data when the retry also fails", async () => {
    const s = spy();
    await recoverFromQuota(quotaError, SIZES, s.evict);
    expect(s.touched.length).toBeGreaterThan(0);
    for (const t of s.touched) expect(USER_TABLES).not.toContain(t);
  });

  it("keeps the reading session temporary when the single retry also fails", async () => {
    const s = spy();
    const { outcome } = await recoverFromQuota(quotaError, SIZES, s.evict);
    expect(outcome).toMatchObject({ status: "temporary-session", evicted: ["semanticPages", "aiCache"] });
    expect(s.touched).toEqual(["semanticPages", "aiCache"]);
  });

  it("retries exactly once", async () => {
    const s = spy();
    let calls = 0;
    await recoverFromQuota(async () => {
      calls += 1;
      return quotaError();
    }, SIZES, s.evict);
    expect(calls).toBe(2);
  });

  it("keeps the session temporary without evicting anything when no derived data exists", async () => {
    const s = spy();
    const outcome = (await recoverFromQuota(quotaError, [size("documents", 10)], s.evict)).outcome;
    expect(outcome).toEqual({ status: "temporary-session", evicted: [], freedBytes: 0 });
    expect(s.touched).toEqual([]);
  });

  it("rethrows non-quota errors without evicting anything", async () => {
    const s = spy();
    await expect(
      recoverFromQuota(async () => {
        throw new Error("transaction conflict");
      }, SIZES, s.evict),
    ).rejects.toThrow("transaction conflict");
    expect(s.touched).toEqual([]);
  });

  it("evicts the largest derived table first", () => {
    expect(planEviction(SIZES)).toEqual(["semanticPages", "aiCache"]);
    expect(derivedBytes(SIZES)).toBe(1_000_000);
  });
});

describe("storage breakdown", () => {
  it("groups originals and reading data as non-freeable, derived as freeable", () => {
    const rows = breakdownByCategory(SIZES);
    const byCategory = new Map(rows.map((r) => [r.category, r]));
    expect(byCategory.get("originals")).toEqual({ category: "originals", bytes: 8_000_000, canFree: false, evictable: false });
    expect(byCategory.get("derived-pages")).toMatchObject({ bytes: 900_000, canFree: true });
    expect(byCategory.get("ai-cache")).toMatchObject({ bytes: 100_000, canFree: true });
    expect(byCategory.get("reading-data")!.bytes).toBe(81_000);
    // Derived rows sort first so the freeable affordances lead.
    expect(rows.slice(0, 2).every((r) => r.evictable)).toBe(true);
  });

  it("never advertises a free action on a user-data category", () => {
    const freeable = new Set(
      breakdownByCategory(SIZES)
        .filter((r) => r.evictable)
        .map((r) => r.category),
    );
    for (const row of breakdownByCategory(SIZES)) {
      expect(row.canFree).toBe(freeable.has(row.category));
    }
  });

  it("reports derived bytes plus dictionary as the only freeable total", () => {
    const report = buildStorageReport({ usage: 9_081_000, quota: 50_000_000 }, SIZES, 250_000, 4_000_000);
    expect(report.freeableBytes).toBe(5_000_000);
    expect(report.used).toBe("8.7 MB");
    expect(report.total).toBe("47.7 MB");
    expect(report.lines.find((l) => l.startsWith("originals"))).toContain("cannot free user data");
    expect(report.lines.find((l) => l.startsWith("derived-pages"))).toContain("can free");
    expect(report.lines.some((l) => l.includes("app-shell"))).toBe(true);
    // No user-data category advertises a free action.
    for (const l of report.lines) {
      if (l.startsWith("originals") || l.startsWith("reading-data")) expect(l).not.toContain("can free");
    }
  });
});