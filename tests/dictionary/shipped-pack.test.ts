import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

/**
 * The shipped pack must satisfy the manifest it ships with, because the
 * installer validates every chunk against it and refuses the pack otherwise.
 * This asserts the real files rather than a fixture, so a regenerated pack that
 * disagrees with its manifest fails here instead of failing silently in a
 * reader's browser.
 */
const DIR = join(process.cwd(), "public", "dictionary");
const manifestPath = join(DIR, "manifest.json");

const skip = existsSync(manifestPath) ? false : "no pack in public/dictionary — run the pack build";

describe.skipIf(skip)("shipped dictionary pack", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    packVersion: string;
    chunks: { file: string; rowCount: number; rawBytes: number; rawSha256: string }[];
    entryCount: number;
    rawBytes: number;
    builtFrom: { license: string; attribution: string; licenseUrl: string };
  };

  it("declares the licence the derivative inherits", () => {
    // CC BY-SA requires the notice to travel with the data. Without these the
    // shipped pack would be redistributing Wiktionary's text unattributed.
    expect(manifest.builtFrom.license).toMatch(/CC BY-SA/);
    expect(manifest.builtFrom.attribution).toMatch(/Wiktionary/);
    expect(manifest.builtFrom.licenseUrl).toMatch(/^https:\/\//);
  });

  it("has every chunk the manifest lists", () => {
    for (const chunk of manifest.chunks) {
      expect(existsSync(join(DIR, chunk.file)), `${chunk.file} is missing`).toBe(true);
    }
  });

  it("has total raw bytes and entry count matching the manifest", () => {
    let rows = 0;
    let bytes = 0;
    for (const chunk of manifest.chunks) {
      const raw = gunzipSync(readFileSync(join(DIR, chunk.file)));
      bytes += raw.byteLength;
      rows += chunk.rowCount;
    }
    expect(rows).toBe(manifest.entryCount);
    expect(bytes).toBe(manifest.rawBytes);
  });

  it("gives at least one real Indonesian gloss for a common word", () => {
    const first = gunzipSync(readFileSync(join(DIR, manifest.chunks[0]!.file)));
    const data = JSON.parse(first.toString("utf8")) as { rows: { normalizedHeadword: string; sense: { gloss: string } | null }[] };
    const glosses = data.rows.filter((r) => r.sense !== null).map((r) => r.sense!.gloss);
    expect(glosses.length).toBeGreaterThan(0);
    // A pack of empty strings would "pass" every count check above.
    expect(glosses.every((g) => g.trim().length > 0)).toBe(true);
  });
});
