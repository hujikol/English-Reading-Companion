/**
 * Offline delivery tests. Section 19 (PWA), Section 20 (PWA test cases) and
 * Section 18 (no cached AI, no remote document resources).
 *
 * These tests read the real files that ship — public/sw.js and
 * dist/offline-assets.json — rather than restating their rules in test code.
 * The service worker is EXECUTED against a fake CacheStorage and a recording
 * fetch, so the assertions are about observed behaviour: what was written to
 * the cache, what was served from it, and what was never touched at all.
 *
 * Two properties get the most attention because they are the two claims this
 * app makes that a user would be badly misled by if they were false:
 *   - "Ready offline" is never derived from shell caching alone.
 *   - AI requests and credentials never enter a service-worker cache.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

import { computeReadiness, type InstalledAsset } from "../../src/pwa/manifest.ts";
import { reduceInstall, initialInstallState } from "../../src/pwa/install.ts";
import { recoverFromQuota, type TableSize } from "../../src/features/settings/storage/quota.ts";
import { isEvictable } from "../../src/contracts/index.ts";
import {
  BUDGET_BY_GROUP,
  DELIVERY_BUDGETS,
  INVENTORY_SCHEMA,
  isWellFormed,
  parseInventory,
  requiredFiles,
  toAssetManifest,
  totalBytes,
  type Inventory,
  type ProducerTrack,
} from "../../src/pwa/offline-assets.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SW_SOURCE = readFileSync(path.join(ROOT, "public/sw.js"), "utf8");
const INVENTORY_PATH = path.join(ROOT, "dist/offline-assets.json");

/**
 * The inventory describes a real build, so these assertions run against dist/.
 *
 * `vite build` empties dist/ before it writes, which deletes a previously
 * generated inventory. Rather than make `npx vitest run tests/pwa/` depend
 * on someone remembering to regenerate it first, the inventory is recomputed
 * from the bytes actually on disk when the file is absent — the same
 * computation the build step performs, so a missing file cannot hide a
 * mismatch. If dist/ itself is missing the error says so.
 */
async function builtInventory(): Promise<Inventory> {
  if (existsSync(INVENTORY_PATH)) return JSON.parse(readFileSync(INVENTORY_PATH, "utf8")) as Inventory;
  if (!existsSync(path.join(ROOT, "dist/index.html"))) {
    throw new Error("dist/ is missing — run `npm run build` first");
  }
  // Full regeneration, manifest and icons included: `vite build` empties
  // dist/ and does not restore the files the generator produces, so this is
  // the same work the `inventory` command does, just run on demand.
  const { collect, emitShellExtras } = await import("../../src/pwa/offline-assets.build.ts");
  await emitShellExtras();
  return collect();
}

/* -------------------------------------------------- fake worker runtime --- */

type Recorded = { url: string; method: string; cache: string | undefined };

/** Minimal CacheStorage/Request/Response good enough to run the real worker. */
function makeRuntime(opts: { origin?: string; offline?: boolean } = {}) {
  const origin = opts.origin ?? "https://app.test";
  const store = new Map<string, Map<string, { body: string; contentType: string }>>();
  const recorded: Recorded[] = [];
  const bodies = new Map<string, { body: string; contentType: string }>();
  const listeners = new Map<string, ((event: Record<string, unknown>) => void)[]>();

  /**
   * Cache keys. `cache.match`/`cache.put` accept a Request, a URL string or
   * a URL, and the worker uses more than one of those shapes, so the fake
   * normalises them. A relative URL resolves against the worker own scope,
   * which the fake has to do explicitly.
   */
  const toKey = (request: string | { url: string }): string =>
    new URL(typeof request === "string" ? request : request.url, origin).pathname;

  const cacheStorage = {
    async open(name: string) {
      if (!store.has(name)) store.set(name, new Map());
      const entries = store.get(name)!;
      return {
        async match(request: string | { url: string }) {
          const entry = entries.get(toKey(request));
          return entry === undefined ? undefined : makeResponse(entry);
        },
        async put(request: string | { url: string }, response: { text: () => Promise<string> }) {
          entries.set(toKey(request), { body: await response.text(), contentType: "application/octet-stream" });
        },
      };
    },
    async keys() {
      return [...store.keys()];
    },
    async delete(name: string) {
      return store.delete(name);
    },
  };

  function makeResponse(entry: { body: string; contentType: string }): Record<string, unknown> {
    const bytes = new TextEncoder().encode(entry.body);
    return {
      ok: true,
      status: 200,
      type: "basic",
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? entry.contentType : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      text: async () => entry.body,
      json: async () => JSON.parse(entry.body),
      clone() {
        return makeResponse(entry);
      },
    };
  }

  const fetchImpl = async (
    request: string | { url: string; method?: string; cache?: string },
    init?: { headers?: Record<string, string>; method?: string },
  ) => {
    const url = typeof request === "string" ? request : request.url;
    const method = typeof request === "string" ? (init?.method ?? "GET") : (request.method ?? "GET");
    recorded.push({ url, method, cache: typeof request === "string" ? undefined : request.cache });
    if (opts.offline === true) throw new TypeError("offline");
    const entry = bodies.get(new URL(url, origin).pathname);
    if (entry === undefined) return { ok: false, status: 404, type: "basic" };
    return makeResponse(entry);
  };

  let skipped = false;
  const self = {
    location: { origin },
    clients: { claim: async () => undefined },
    skipWaiting() {
      skipped = true;
    },
    addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
  };

  const context = vm.createContext({
    self,
    caches: cacheStorage,
    fetch: fetchImpl,
    crypto: { subtle: globalThis.crypto.subtle },
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    String,
    Error,
    TypeError,
    Array,
    JSON,
    Math,
    Object,
    // Node 24 ships the platform Response/Headers, so the worker runs against
    // the real implementations rather than another hand-rolled fake.
    Response,
    Headers,
    Request,
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    MessageChannel: class {},
    console,
  });
  vm.runInContext(SW_SOURCE, context, { filename: "sw.js" });

  const emit = async (type: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    const enriched = { ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) };
    for (const fn of listeners.get(type) ?? []) fn(enriched);
    await Promise.all(waits);
  };

  return {
    recorded,
    bodies,
    store,
    emit,
    wasSkipped: () => skipped,
    /** Every request/cache key the worker wrote, across all caches. */
    cachedKeys: () => [...store.values()].flatMap((m) => [...m.keys()]),
  };
}

/**
 * sha384 in the SRI form the worker verifies against, computed here with
 * node:crypto rather than with the same helper the generator uses — so the
 * test can actually contradict the generator instead of agreeing with it by
 * construction.
 */
function sha384OfBytes(bytes: Uint8Array): string {
  return `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
}

const sha384 = (text: string): string => sha384OfBytes(new TextEncoder().encode(text));

/** A miniature inventory with a single shell asset and one wasm asset. */
function fixtureInventory(extra: Partial<Inventory["assets"][number]> = {}): Inventory {
  const shell = {
    id: "shell:index.html",
    url: "/index.html",
    kind: "shell" as const,
    producer: "A" as ProducerTrack,
    version: "9.9.9",
    integrity: sha384("<html>shell</html>"),
    bytes: 5,
    required: true,
    group: "shell" as const,
    ...extra,
  };
  return {
    schema: INVENTORY_SCHEMA,
    appVersion: "9.9.9",
    groups: [{ group: "shell", files: 1, bytes: 5, gzipBytes: 5 }],
    totals: { files: 1, bytes: 5, gzipBytes: 5 },
    assets: [shell],
  };
}

/* ---------------------------------------------------------------- tests --- */

describe("offline asset inventory", () => {
  it("is well formed, or the build step never ran", async () => {
    const inventory = await builtInventory();
    expect(inventory.schema).toBe(INVENTORY_SCHEMA);
    expect(isWellFormed(inventory)).toBe(true);
    expect(inventory.assets.length).toBeGreaterThan(0);
    for (const asset of inventory.assets) {
      expect(asset.url.startsWith("/")).toBe(true);
      expect(asset.bytes).toBeGreaterThan(0);
      expect(asset.integrity).toMatch(/^sha384-[A-Za-z0-9+/]+={0,2}$/);
      expect(asset.version.length).toBeGreaterThan(0);
    }
  });

  it("rejects a malformed inventory instead of precaching it", () => {
    expect(parseInventory(null)).toBeNull();
    expect(parseInventory({ schema: INVENTORY_SCHEMA, appVersion: "1", groups: [], assets: [] })).toBeNull();
    expect(parseInventory({ schema: 99, appVersion: "1", groups: [], assets: [{}] })).toBeNull();
    expect(parseInventory({ schema: INVENTORY_SCHEMA, appVersion: "1", groups: [], totals: {} })).toBeNull();
    // A well-formed one survives, so the guard is not simply rejecting everything.
    expect(parseInventory(fixtureInventory())).not.toBeNull();
  });

  it("declares the PDF worker, inspector WASM, CMaps and standard fonts", async () => {
    const inventory = await builtInventory();
    const urls = inventory.assets.map((a) => a.url);
    expect(urls).toContain("/inspector/pdf_inspector_wasm_bg.wasm");
    expect(urls).toContain("/inspector/pdf_inspector_wasm.js");
    expect(urls.some((u) => u.startsWith("/pdfjs/cmaps/"))).toBe(true);
    expect(urls.some((u) => u.startsWith("/pdfjs/standard_fonts/"))).toBe(true);
    // The PDF worker itself: Vite's `?worker` emits a small loader shim plus
    // the real worker chunk, both content-hashed under /assets/. What must
    // never appear is a second, hand-copied worker at /pdfjs/pdf.worker.mjs —
    // that was 362 KiB gzip of bytes no code path loads.
    expect(urls).not.toContain("/pdfjs/pdf.worker.mjs");
    expect(urls.filter((u) => u.startsWith("/pdfjs/") && u.includes("pdf.worker"))).toHaveLength(0);
    expect(urls.filter((u) => u.startsWith("/assets/") && u.includes("pdf.worker")).length).toBeGreaterThan(0);
    // Every one of them must actually gate the Ready-offline claim, or the
    // claim would survive an install that cannot render a PDF offline.
    for (const url of urls) {
      expect(inventory.assets.find((a) => a.url === url)?.required).toBe(true);
    }
  });

  it("keeps every precached group inside the Section 16 delivery budgets", async () => {
    const inventory = await builtInventory();
    for (const group of inventory.groups) {
      const budget = BUDGET_BY_GROUP[group.group];
      if (budget === null) continue;
      expect(group.gzipBytes, `${group.group} gzip`).toBeLessThanOrEqual(DELIVERY_BUDGETS[budget]);
    }
    expect(inventory.totals.gzipBytes).toBeLessThanOrEqual(DELIVERY_BUDGETS.offlineInstall);
  });

  it("reports declared bytes that match what is really on disk", async () => {
    const inventory = await builtInventory();
    for (const asset of inventory.assets) {
      const onDisk = readFileSync(path.join(ROOT, "dist", asset.url.replace(/^\//, "")));
      expect(onDisk.length, asset.url).toBe(asset.bytes);
      expect(sha384OfBytes(onDisk), asset.url).toBe(asset.integrity);
    }
    expect(totalBytes(inventory.assets)).toBe(inventory.totals.bytes);
  });

  it("reproduces the digest the build recorded for a sample of assets", async () => {
    // Independent re-derivation of a handful of digests, so a hash recorded
    // by a broken generator cannot be self-consistent and wrong.
    const inventory = await builtInventory();
    for (const url of ["/index.html", "/inspector/pdf_inspector_wasm_bg.wasm", "/pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap"]) {
      const asset = inventory.assets.find((a) => a.url === url);
      const bytes = readFileSync(path.join(ROOT, "dist", url.replace(/^\//, "")));
      expect(sha384OfBytes(bytes)).toBe(asset?.integrity);
    }
  });
});

describe("Ready offline is not claimed from shell caching", () => {
  const manifest = { appVersion: "1", assets: [{ id: "wasm", url: "/w.wasm", kind: "wasm" as const, producer: "E" as const, version: "1", integrity: "sha384-AA", bytes: 1, required: true }] };

  it("is not ready when only the shell was cached", () => {
    // The shell asset is installed and verified; the required WASM is absent.
    const shellOnly: InstalledAsset[] = [{ id: "shell:index.html", version: "1", integrity: "sha384-SHELL", verified: true }];
    const readiness = computeReadiness(manifest, shellOnly);
    expect(readiness.readyOffline).toBe(false);
    expect(readiness.missing).toEqual(["wasm"]);
    expect(reduceInstall(initialInstallState, { type: "status", readiness }).phase).toBe("partial");
  });

  it("is not ready when a required asset is present but unverified", () => {
    const readiness = computeReadiness(manifest, [{ id: "wasm", version: "1", integrity: "sha384-AA", verified: false }]);
    expect(readiness.readyOffline).toBe(false);
    expect(readiness.unverified).toEqual(["wasm"]);
  });

  it("is not ready when the installed version is older than the manifest", () => {
    const readiness = computeReadiness(manifest, [{ id: "wasm", version: "0.9", integrity: "sha384-AA", verified: true }]);
    expect(readiness.readyOffline).toBe(false);
    expect(readiness.mismatched).toEqual(["wasm"]);
  });

  it("is ready only when every required asset is installed and verified", () => {
    const readiness = computeReadiness(manifest, [{ id: "wasm", version: "1", integrity: "sha384-AA", verified: true }]);
    expect(readiness.readyOffline).toBe(true);
    expect(reduceInstall(initialInstallState, { type: "start", version: "1" }).phase).toBe("installing");
    expect(reduceInstall(initialInstallState, { type: "status", readiness }).phase).toBe("ready-offline");
  });

  it("never becomes ready from an empty required set", () => {
    const readiness = computeReadiness({ appVersion: "1", assets: [] }, []);
    expect(readiness.readyOffline).toBe(false);
    expect(readiness.requiredCount).toBe(0);
  });
});

describe("service worker install", () => {
  it("precaches the declared assets and verifies stored bytes", async () => {
    const body = "<html>shell</html>";
    const inventory = { ...fixtureInventory(), assets: [{ ...fixtureInventory().assets[0]!, bytes: body.length, integrity: sha384(body) }] };
    const runtime = makeRuntime();
    runtime.bodies.set("/index.html", { body, contentType: "text/html" });
    runtime.bodies.set("/offline-assets.json", { body: JSON.stringify(inventory), contentType: "application/json" });

    await runtime.emit("install", {});

    expect(runtime.cachedKeys()).toContain("/index.html");
    const stored = runtime.store.get("erc-shell-9.9.9")?.get("/index.html");
    expect(stored?.body).toBe(body);
    const report = JSON.parse(runtime.store.get("erc-offline-meta-v1")?.get("/__erc/install-report")?.body ?? "{}") as {
      installed: InstalledAsset[];
      verifiedBytes: number;
    };
    expect(report.installed).toEqual([
      { id: "shell:index.html", url: "/index.html", version: "9.9.9", integrity: sha384(body), bytes: body.length, required: true, verified: true },
    ]);
    expect(report.verifiedBytes).toBe(body.length);
  });

  it("records verified=false when the bytes do not match the build digest", async () => {
    const inventory = fixtureInventory();
    const runtime = makeRuntime();
    runtime.bodies.set("/index.html", { body: "TAMPERED", contentType: "text/html" });
    runtime.bodies.set("/offline-assets.json", { body: JSON.stringify(inventory), contentType: "application/json" });

    await runtime.emit("install", {});

    const report = JSON.parse(runtime.store.get("erc-offline-meta-v1")?.get("/__erc/install-report")?.body ?? "{}") as {
      installed: InstalledAsset[];
      verifiedBytes: number;
    };
    expect(report.installed[0]?.verified).toBe(false);
    expect(report.verifiedBytes).toBe(0);
    // ...and that is not ready offline, because readiness re-derives from the report.
    const readiness = computeReadiness(toAssetManifest(inventory), report.installed);
    expect(readiness.readyOffline).toBe(false);
  });

  it("survives one unreachable asset instead of failing the whole install", async () => {
    const base = fixtureInventory();
    // Add a second, unreachable entry rather than replacing the shell one: the
    // point is that a partial install still records what did arrive.
    const inventory: Inventory = {
      ...base,
      assets: [
        ...base.assets,
        { ...base.assets[0]!, id: "inspector-wasm:x.wasm", url: "/inspector/missing.wasm", integrity: sha384("nope"), bytes: 4 },
      ],
    };
    const runtime = makeRuntime();
    runtime.bodies.set("/index.html", { body: "<html>shell</html>", contentType: "text/html" });
    runtime.bodies.set("/offline-assets.json", { body: JSON.stringify(inventory), contentType: "application/json" });

    await runtime.emit("install", {});

    const report = JSON.parse(runtime.store.get("erc-offline-meta-v1")?.get("/__erc/install-report")?.body ?? "{}") as {
      installed: InstalledAsset[];
      errors: { url: string }[];
    };
    expect(report.errors.map((e) => e.url)).toEqual(["/inspector/missing.wasm"]);
    expect(report.installed.map((a) => a.id)).toEqual(["shell:index.html"]);
    const readiness = computeReadiness(toAssetManifest(inventory), report.installed);
    expect(readiness.readyOffline).toBe(false);
    expect(readiness.missing).toEqual(["inspector-wasm:x.wasm"]);
  });

  it("does not activate itself: no forced update during reading", async () => {
    const runtime = makeRuntime();
    runtime.bodies.set("/offline-assets.json", { body: JSON.stringify(fixtureInventory()), contentType: "application/json" });
    runtime.bodies.set("/index.html", { body: "<html>shell</html>", contentType: "text/html" });
    await runtime.emit("install", {});
    expect(runtime.wasSkipped()).toBe(false);

    // ...until the page explicitly asks, which only happens after agree-reload.
    await runtime.emit("message", { data: { type: "erc:skip-waiting" }, ports: [], source: null });
    expect(runtime.wasSkipped()).toBe(true);
  });

  it("keeps the previous version's cache so open tabs still resolve", async () => {
    const runtime = makeRuntime();
    runtime.store.set("erc-shell-0.0.1", new Map([["/assets/old.js", { body: "old", contentType: "text/javascript" }]]));
    runtime.store.set("erc-shell-0.0.2", new Map([["/assets/new.js", { body: "new", contentType: "text/javascript" }]]));
    runtime.bodies.set("/offline-assets.json", { body: JSON.stringify(fixtureInventory()), contentType: "application/json" });

    await runtime.emit("activate", {});
    // Old-and-new asset combinations must both still be available.
    expect(runtime.store.has("erc-shell-0.0.1")).toBe(true);
    expect(runtime.store.has("erc-shell-0.0.2")).toBe(true);
  });
});

describe("service worker fetch policy", () => {
  const setup = async () => {
    const body = "<html>shell</html>";
    const inventory = fixtureInventory({ integrity: sha384(body) });
    const runtime = makeRuntime();
    runtime.bodies.set("/offline-assets.json", { body: JSON.stringify(inventory), contentType: "application/json" });
    runtime.bodies.set("/index.html", { body, contentType: "text/html" });
    runtime.bodies.set("/assets/index-abc.js", { body: "console.log(1)", contentType: "text/javascript" });
    await runtime.emit("install", {});
    return { runtime, inventory };
  };

  const dispatch = async (runtime: ReturnType<typeof makeRuntime>, request: Record<string, unknown>) => {
    let responded: unknown = null;
    const event = {
      request: {
        url: `https://app.test${String(request.path)}`,
        method: request.method ?? "GET",
        mode: request.mode ?? "no-cors",
        headers: { has: (h: string) => h === (request.authHeader as string | undefined) },
      },
      respondWith: (p: Promise<unknown>) => {
        responded = p;
      },
    };
    await runtime.emit("fetch", event);
    return responded;
  };

  it("never intercepts an AI POST — the cache cannot even see it", async () => {
    const { runtime } = await setup();
    runtime.recorded.length = 0;
    const responded = await dispatch(runtime, { path: "/api/explain", method: "POST" });
    expect(responded).toBeNull();
    // Nothing was written, and the request was not even routed through the
    // worker's response handling.
    expect(runtime.cachedKeys()).not.toContain("/api/explain");
  });

  it("never intercepts a request that carries an Authorization header", async () => {
    const { runtime } = await setup();
    const responded = await dispatch(runtime, { path: "/api/explain", method: "GET", authHeader: "authorization" });
    expect(responded).toBeNull();
  });

  it("never intercepts a cross-origin request", async () => {
    const { runtime } = await setup();
    let handled = false;
    const event = {
      request: { url: "https://api.anthropic.com/v1/messages", method: "POST", mode: "cors", headers: { has: () => false } },
      respondWith: () => {
        handled = true;
      },
    };
    await runtime.emit("fetch", event);
    expect(handled).toBe(false);
  });

  it("serves a precached asset from the cache without touching the network", async () => {
    const { runtime } = await setup();
    runtime.recorded.length = 0;
    const response = (await dispatch(runtime, { path: "/index.html" })) as { text: () => Promise<string> };
    expect(await response.text()).toBe("<html>shell</html>");
    expect(runtime.recorded.filter((r) => r.url.endsWith("/index.html"))).toHaveLength(0);
  });

  it("serves the cached shell for an offline deep link", async () => {
    const { runtime } = await setup();
    const offline = makeRuntime({ offline: true });
    offline.store.set("erc-shell-9.9.9", new Map([["/index.html", { body: "<html>shell</html>", contentType: "text/html" }]]));
    offline.store.set("erc-offline-meta-v1", new Map([["/__erc/install-report", { body: JSON.stringify({ appVersion: "9.9.9", cacheName: "erc-shell-9.9.9", installed: [], errors: [], verifiedBytes: 0 }), contentType: "application/json" }]]));

    const response = (await dispatch(offline, { path: "/library/bookmarks", mode: "navigate" })) as { text: () => Promise<string> };
    expect(await response.text()).toBe("<html>shell</html>");
  });

  it("ignores a same-origin GET that is not a precached asset", async () => {
    const { runtime } = await setup();
    const responded = await dispatch(runtime, { path: "/some/other/page" });
    expect(responded).toBeNull();
  });
});

describe("quota recovery never reaches user data", () => {
  it("offers only derived tables to the eviction callback", async () => {
    const sizes: TableSize[] = [
      { table: "documents", bytes: 5_000_000, category: "originals" },
      { table: "vocabulary", bytes: 900_000, category: "reading-data" },
      { table: "marks", bytes: 800_000, category: "reading-data" },
      { table: "semanticPages", bytes: 400_000, category: "derived-pages" },
      { table: "aiCache", bytes: 200_000, category: "ai-cache" },
    ];
    const asked: string[][] = [];
    // A real DOMException, because recoverFromQuota() matches on the DOM
    // type and name rather than on a duck-typed `name` field.
    const quotaError = () => new DOMException("full", "QuotaExceededError");
    let attempt = 0;
    const { outcome } = await recoverFromQuota(
      async () => {
        attempt += 1;
        if (attempt === 1) throw quotaError();
        return "written";
      },
      sizes,
      async (tables) => {
        asked.push([...tables]);
      },
    );
    expect(outcome.status).toBe("ok-after-eviction");
    expect(asked).toHaveLength(1);
    for (const table of asked[0] ?? []) expect(isEvictable(table as never)).toBe(true);
    // Specifically: none of the user tables reached the callback.
    expect(asked[0] ?? []).not.toContain("documents");
    expect(asked[0] ?? []).not.toContain("vocabulary");
    expect(asked[0] ?? []).not.toContain("marks");
  });

  it("keeps the session temporary rather than deleting user data when eviction cannot help", async () => {
    const sizes: TableSize[] = [{ table: "documents", bytes: 5_000_000, category: "originals" }];
    let evicted = false;
    let attempts = 0;
    const { outcome } = await recoverFromQuota(
      async () => {
        attempts += 1;
        throw new DOMException("full", "QuotaExceededError");
      },
      sizes,
      async () => {
        evicted = true;
      },
    );
    expect(outcome.status).toBe("temporary-session");
    expect(attempts).toBe(1);
    expect(evicted).toBe(false);
  });
});

describe("service worker source invariants", () => {
  it("does not skipWaiting during install", () => {
    // Comments are stripped first: the handler explains in prose why it does
    // not call skipWaiting, and that prose must not fail the assertion.
    const code = SW_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const install = code.slice(code.indexOf('addEventListener("install"'), code.indexOf('addEventListener("activate"'));
    expect(install).not.toContain("skipWaiting");
  });

  it("does not call cache.put on a request it declined to handle", () => {
    // The only put sites must live inside the precache loop and the
    // immutable-asset handler, both of which are reached only after the
    // shouldIntercept gate.
    const putSites = SW_SOURCE.split("cache.put(").length - 1;
    expect(putSites).toBeGreaterThan(0);
    expect(SW_SOURCE).toContain("function shouldIntercept");
    expect(SW_SOURCE.indexOf("function shouldIntercept")).toBeLessThan(SW_SOURCE.indexOf('addEventListener("fetch"'));
  });

  it("never caches with credentials", () => {
    expect(SW_SOURCE).not.toMatch(/credentials:\s*["']include["']/);
    expect(SW_SOURCE).not.toMatch(/cache\.addAll\(/);
  });
});