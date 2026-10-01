/**
 * The slice of Dexie that Track F touches.
 *
 * Operations are written against `Store` instead of `AppDB` directly so unit
 * tests can run a plain in-memory double. `trackFStore()` is the one production
 * adapter and the only place the Dexie types meet this port, so a signature
 * mismatch shows up here instead of at a call site.
 *
 * ponytail: deliberately index-free. Vocabulary-sized tables are hundreds of
 * rows, so a JS `filter` beats threading Dexie's WhereClause generics through
 * this port. Add a Store method when a real query plan needs one.
 */

import { db } from "../../db/index.ts";

export type Query<T> = {
  toArray(): Promise<T[]>;
  first(): Promise<T | undefined>;
  delete(): Promise<number>;
  limit(n: number): Query<T>;
};

/** mirrors Dexie's real return types; a looser port would not accept AppDB */
export type TableLike<T> = {
  get(key: string): Promise<T | undefined>;
  put(item: T, key?: string): Promise<string>;
  bulkPut(items: readonly T[]): Promise<string>;
  bulkDelete(keys: readonly string[]): Promise<void>;
  delete(key: string): Promise<void>;
  toArray(): Promise<T[]>;
  count(): Promise<number>;
  filter(fn: (item: T) => boolean): Query<T>;
};

export type Store = {
  bookmarks: TableLike<unknown>;
  marks: TableLike<unknown>;
  vocabulary: TableLike<unknown>;
  occurrences: TableLike<unknown>;
  explanations: TableLike<unknown>;
  reviewCards: TableLike<unknown>;
  reviewEvents: TableLike<unknown>;
  settings: TableLike<unknown>;
  transaction<T>(mode: "rw", tables: readonly unknown[], scope: () => Promise<T>): Promise<T>;
};

/** Production adapter. The structural check lives at this assignment, not in a
 * separate assertion file. */
export const trackFStore: Store = db;