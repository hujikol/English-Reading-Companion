import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dictDb } from "../../src/features/dictionary/db.ts";
import { loadDictionary } from "../../src/features/dictionary/loadPack.ts";
import { lookupSurface } from "../../src/ui/vocab/dictionaryLookup.ts";
afterEach(async () => { vi.unstubAllGlobals(); await dictDb.delete(); });
it("installs the real shipped dictionary from mixed gzip/plain transport, then looks up Indonesian meanings", async () => {
  await dictDb.delete(); await dictDb.open();
  const request = vi.fn(async (url: string) => {
    const file = url.replace("/dictionary/", "");
    const bytes = readFileSync(`public/dictionary/${file}`);
    const payload = file.endsWith("0000.json.gz") ? gunzipSync(bytes) : bytes;
    return new Response(payload);
  });
  vi.stubGlobal("fetch", request);
  const state = await loadDictionary();
  expect(state.kind).toBe("ready");
  expect(await dictDb.entries.count()).toBe(JSON.parse(readFileSync("public/dictionary/manifest.json", "utf8")).entryCount);
  const hit = await lookupSurface("water,");
  expect(hit.found).toBe(true);
  if (hit.found) expect(hit.result.senses.some(s => s.gloss.includes("air"))).toBe(true);
  const requests = request.mock.calls.length;
  await loadDictionary();
  expect(request.mock.calls.length).toBe(requests + 1);
  request.mockRejectedValueOnce(new Error("Offline"));
  expect((await loadDictionary()).kind).toBe("ready");
  expect((await lookupSurface("water")).found).toBe(true);
});
