import { AppDB, db } from "../src/db/index.ts";

/**
 * Fault injection for tests.
 *
 * Three suites need to make ONE Dexie method fail — a quota rejection, a closed
 * database — and assert that the UI reports "not saved" rather than lying. With
 * a real database there is no seam to break, so a test replaces a single method
 * on a shallow copy.
 *
 * That was the whole reason the hand-written `Store` port existed, and it is
 * still worth something: the alternative is a double that reimplements Dexie
 * and can drift from it. Here the double is one line, and everything else is
 * the real table.
 */

/** `db` with `transaction` replaced. The failure every "write failed" path shares. */
export function withFailingTransaction(message: string): AppDB {
  return { ...db, transaction: () => Promise.reject(new Error(message)) } as unknown as AppDB;
}

/**
 * `db` with one table's `put` replaced, for a failure INSIDE the transaction.
 *
 * `db` is a Dexie instance, so `transaction` lives on its prototype. A shallow
 * object spread drops it, and the caller fails with
 * "store.transaction is not a function" instead of the quota error it is
 * testing. The prototype is kept; only the named table is replaced.
 */
export function withFailingPut(table: "reviewEvents", message: string): AppDB {
  const proxy = Object.create(Object.getPrototypeOf(db)) as AppDB;
  for (const key of Object.keys(db)) {
    const value = (db as unknown as Record<string, unknown>)[key];
    if (key !== table) {
      (proxy as unknown as Record<string, unknown>)[key] = value;
      continue;
    }
    // Delegating wrapper, not a copy: a Dexie Table's methods live on its own
    // prototype, so spreading it yields an object with no `.get`/`.put`.
    const real = value as object;
    (proxy as unknown as Record<string, unknown>)[key] = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "put") return () => Promise.reject(new Error(message));
        const member = Reflect.get(target, prop, target) as unknown;
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  }
  return proxy;
}

/**
 * A SECOND, isolated database.
 *
 * `memStore()` used to hand every test its own empty store for free. The real
 * `db` is shared, so a test that exports a backup from a seeded store and then
 * asserts a second store stayed empty needs genuine separation — two databases,
 * not one cleared one, because clearing between the two operations would
 * destroy the fixture it just exported.
 */
export function isolatedDb(name: string): AppDB {
  return new AppDB(name);
}
