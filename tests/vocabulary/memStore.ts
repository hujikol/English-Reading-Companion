import type { Query, Store, TableLike } from "../../src/features/vocabulary/store.ts";

/**
 * Minimal in-memory `Store`. IndexedDB is absent in the vitest node environment
 * and no polyfill may be added, so unit tests run on this; the F2 gate covers
 * Dexie in a real browser.
 *
 * ponytail: keyed by each table's Dexie primary key and nothing else. No
 * ordering, no index, rollback instead of real transactions.
 */

/** mirrors the `stores()` schema in src/db/index.ts */
const PRIMARY: Record<string, string> = {
  bookmarks: "id",
  marks: "id",
  vocabulary: "id",
  occurrences: "id",
  explanations: "requestHash",
  reviewCards: "vocabularyId",
  reviewEvents: "id",
  settings: "key",
};

export function memStore(): Store {
  const tables = new Map<string, Map<string, unknown>>();

  const table = <T>(name: string): TableLike<T> => {
    const pk = PRIMARY[name];
    if (!pk) throw new Error(`memStore: no primary key known for ${name}`);
    const key = (item: unknown): string => (item as Record<string, unknown>)[pk] as string;

    const rows = (): Map<string, unknown> => {
      let m = tables.get(name);
      if (!m) tables.set(name, (m = new Map()));
      return m;
    };
    const put = async (item: T, explicit?: string): Promise<string> => {
      const k = explicit ?? key(item);
      if (!k) throw new Error(`memStore: ${name} row has no ${pk}`);
      rows().set(k, item);
      return k;
    };
    const q = (items: T[]): Query<T> => ({
      toArray: async () => items,
      first: async () => items[0],
      delete: async () => {
        const live = rows();
        for (const item of items) live.delete(key(item));
        return items.length;
      },
      limit: (n: number) => q(items.slice(0, n)),
    });

    return {
      get: async (k: string) => rows().get(k) as T | undefined,
      put,
      bulkPut: async (items: readonly T[]) => {
        for (const item of items) await put(item);
        return "" as unknown as string;
      },
      bulkDelete: async (keys: readonly string[]) => {
        for (const k of keys) rows().delete(k);
      },
      delete: async (k: string) => {
        rows().delete(k);
      },
      toArray: async () => [...rows().values()] as T[],
      count: async () => rows().size,
      filter: (fn: (item: T) => boolean) => q(([...rows().values()] as T[]).filter(fn)),
    };
  };

  return {
    bookmarks: table("bookmarks"),
    marks: table("marks"),
    vocabulary: table("vocabulary"),
    occurrences: table("occurrences"),
    explanations: table("explanations"),
    reviewCards: table("reviewCards"),
    reviewEvents: table("reviewEvents"),
    settings: table("settings"),
    /** snapshot-and-rollback: a throwing scope leaves the store as it was */
    transaction: async (_mode, _tables, scope) => {
      const snapshot = new Map([...tables].map(([n, m]) => [n, new Map(m)]));
      try {
        return await scope();
      } catch (error) {
        for (const n of [...tables.keys()]) {
          const live = tables.get(n);
          const before = snapshot.get(n);
          if (!live || !before) continue;
          live.clear();
          for (const [k, v] of before) live.set(k, v);
        }
        throw error;
      }
    },
  };
}