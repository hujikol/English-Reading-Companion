/**
 * One runnable check for the lookup contract, using a hand-rolled in-memory
 * stand-in for the two Dexie tables the lookup touches. No IndexedDB, no
 * fake-indexeddb dependency, no network stub needed because the miss path makes
 * no request at all — there is no fetch to intercept.
 */

import { describe, expect, it } from "vitest";
import type { EntryRow } from "../../src/features/dictionary/pack.ts";
import { normalizeForm } from "../../src/features/dictionary/pack.ts";
import type { AliasRow, PackRecord } from "../../src/features/dictionary/db.ts";
import type { DictionaryDB } from "../../src/features/dictionary/db.ts";
import { lookup } from "../../src/features/dictionary/lookup.ts";

const VERSION = "test-1";

const entry = (
  headword: string,
  senseId: number,
  opts: { gloss?: string; pos?: string; aliases?: string[]; irregular?: string[] } = {},
): EntryRow => ({
  packVersion: VERSION,
  normalizedHeadword: normalizeForm(headword),
  senseId,
  headword,
  partOfSpeech: opts.pos ?? "noun",
  sense: senseId === 0 ? null : { gloss: opts.gloss ?? `${headword} gloss`, synonyms: [] },
  aliases: opts.aliases ?? [],
  irregularForms: opts.irregular ?? [],
});

const pack = (over: Partial<PackRecord> = {}): PackRecord =>
  ({
    packVersion: VERSION,
    state: "active",
    installedAt: 1,
    manifest: {
      entryCount: 3,
      headwordCount: 2,
      compressedBytes: 10,
      builtFrom: {
        sourceUrl: "u",
        sourceRevision: "r",
        sourceSha256: "s",
        license: "CC-BY-SA-4.0",
        licenseUrl: "l",
        attribution: "a",
      },
    },
    ...over,
  }) as PackRecord;

/**
 * Minimal duck-typed store. The compound-key range is HONORED — a stub that
 * returned every row for any query would report a hit for every lookup and the
 * miss path would be untested.
 */
const fakeDb = (rows: EntryRow[], aliases: AliasRow[], packs: PackRecord[] = [pack()]) => {
  // Real compound-key ordering. Dexie's `between([v,w,-Infinity],[v,w,Infinity])` is
  // the idiom for "all senses of one headword" — comparing with JSON.stringify
  // would order "-Infinity" as a STRING and silently match nothing.
  type Key = [string, string, number];
  const keyOf = (r: EntryRow): Key => [r.packVersion, r.normalizedHeadword, r.senseId];
  const cmp = (a: Key, b: Key): number =>
    a[0] === b[0] ? (a[1] === b[1] ? a[2] - b[2] : a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1;
  const inRange = (lo: Key, hi: Key) => rows.filter((r) => cmp(keyOf(r), lo) >= 0 && cmp(keyOf(r), hi) <= 0);

  return {
    entries: {
      where: () => ({
        between: (lo: Key, hi: Key) => ({ toArray: async () => inRange(lo, hi) }),
        equals: (k: Key) => ({ toArray: async () => inRange(k, k) }),
      }),
    },
    aliases: {
      where: () => ({
        equals: ([alias, version]: [string, string]) => ({
          toArray: async () => aliases.filter((a) => a.alias === alias && a.packVersion === version),
        }),
        between: () => ({ toArray: async () => aliases }),
      }),
    },
    packs: {
      where: () => ({
        equals: (state: string) => ({
          first: async () => packs.find((p) => p.state === state) ?? null,
        }),
      }),
    },
  } as unknown as DictionaryDB;
};

describe("lookup", () => {
  it("resolves an exact headword with every sense", async () => {
    const db = fakeDb([entry("leverage", 1, { gloss: "menggunakan" }), entry("leverage", 2, { gloss: "daya ungkit" })], []);
    const r = await lookup({ db, surface: "leverage" });
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.result.senses.map((s) => s.gloss)).toEqual(["menggunakan", "daya ungkit"]);
    expect(r.result.matchedVia).toBe("exact");
  });

  it("omits the senseId 0 placeholder row", async () => {
    const db = fakeDb([entry("dog", 0), entry("dog", 1, { gloss: "anjing" })], []);
    const r = await lookup({ db, surface: "dog" });
    expect(r.found && r.result.senses.length).toBe(1);
  });

  it("returns null on a miss and fabricates nothing", async () => {
    const db = fakeDb([entry("leverage", 1)], []);
    const r = await lookup({ db, surface: "zzzznotaword" });
    expect(r.found).toBe(false);
    if (r.found) return;
    expect(r.reason).toBe("not-in-pack");
    expect(r.candidates).toEqual([]);
    // the whole contract: no invented lemma, no invented gloss
    expect(JSON.stringify(r)).not.toMatch(/gloss\"|headword":"/);
  });

  it("returns empty-surface and no-active-pack without touching entries", async () => {
    const db = fakeDb([entry("dog", 1)], []);
    expect((await lookup({ db, surface: "   " })).found).toBe(false);
    const empty = fakeDb([entry("dog", 1)], [], []);
    const r = await lookup({ db: empty, surface: "dog" });
    expect(!r.found && r.reason).toBe("no-active-pack");
  });

  it("suffix candidates only ever return rows that exist", async () => {
    // "running" must not yield an invented "run"
    const db = fakeDb([entry("leverage", 1)], []);
    const miss = await lookup({ db, surface: "running" });
    expect(!miss.found && miss.candidates).toEqual([]);

    const real = fakeDb([entry("run", 1, { gloss: "berlari" })], []);
    const hit = await lookup({ db: real, surface: "running" });
    expect(hit.found).toBe(false);
    if (hit.found) return;
    expect(hit.candidates.map((c) => c.headword)).toEqual(["run"]);
    expect(hit.candidates[0]?.senses[0]?.gloss).toBe("berlari");
  });

  it("caps candidates", async () => {
    const rows = ["ing", "ed", "er", "est"].map((s, i) => entry(`lev${s}`, i + 1));
    const db = fakeDb(rows, []);
    const r = await lookup({ db, surface: "levering", maxCandidates: 2 });
    expect(!r.found && r.candidates.length).toBeLessThanOrEqual(2);
  });

  it("follows an alias and an irregular form to the real headword", async () => {
    const aliasRows: AliasRow[] = [
      { alias: "lvrg", packVersion: VERSION, normalizedHeadword: "leverage" },
      { alias: "ran", packVersion: VERSION, normalizedHeadword: "run" },
    ];
    const db = fakeDb([entry("leverage", 1, { gloss: "menggunakan" })], aliasRows);
    const viaAlias = await lookup({ db, surface: "LVRG" });
    expect(viaAlias.found && viaAlias.result.headword).toBe("leverage");

    const db2 = fakeDb([entry("run", 1, { gloss: "berlari" })], aliasRows);
    const viaIrregular = await lookup({ db: db2, surface: "ran" });
    expect(viaIrregular.found && viaIrregular.result.headword).toBe("run");
  });

  it("prefers an exact entry over an alias collision", async () => {
    const aliasRows: AliasRow[] = [{ alias: "art", packVersion: VERSION, normalizedHeadword: "leverage" }];
    const db = fakeDb([entry("art", 1, { gloss: "seni" }), entry("leverage", 1, { gloss: "daya" })], aliasRows);
    const r = await lookup({ db, surface: "art" });
    expect(r.found && r.result.headword).toBe("art");
  });
});
