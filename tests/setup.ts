import "fake-indexeddb/auto";

import { beforeEach } from "vitest";
import { db } from "../src/db/index.ts";

/**
 * A real IndexedDB in Node, so tests exercise the actual Dexie tables instead
 * of a hand-written double. That double (`features/vocabulary/store.ts` plus
 * `tests/vocabulary/memStore.ts`, 148 lines) is deleted because its only reason
 * to exist was the absence of IndexedDB here.
 *
 * The cost of the upgrade is this file: the real database is SHARED between
 * tests in a file, so a test that seeds three words leaks into the next one.
 * Clearing is the honest equivalent of the fresh store the double gave away.
 *
 * Must load before any module constructs a Dexie instance, hence the vitest
 * `setupFiles` entry rather than an import inside a test.
 */
beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
});
