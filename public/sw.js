/* eslint-env serviceworker */
/**
 * Service worker. Sections 19 and 18.
 *
 * WHY PLAIN JAVASCRIPT IN public/ AND NOT A TYPESCRIPT BUILD STEP
 * The worker must be served from /sw.js to hold root scope. Producing it from
 * TypeScript would mean adding a build input to vite.config.ts, which this
 * track does not own. So the worker is a static file with no imports.
 *
 * WHAT DELIBERATELY DOES NOT LIVE HERE
 * The readiness decision. computeReadiness() (src/pwa/manifest.ts) is tested
 * policy and it runs on the page, which asks this worker what it actually
 * holds and re-derives the claim from that. This file only moves bytes and
 * measures digests. A worker that also decided "Ready offline" would give us
 * two disagreeing sources of truth for the most safety-relevant string in
 * the product.
 *
 * THREE HARD RULES, ENFORCED IN `shouldIntercept` BELOW
 *  1. A non-GET request is never intercepted. AI calls are POSTs; they go
 *     straight to the network and can never be read from or written to a
 *     cache.
 *  2. A cross-origin request is never intercepted, whatever its method.
 *  3. A request carrying an Authorization header is never intercepted and
 *     never stored, so a credential cannot end up in CacheStorage.
 */

const CACHE_PREFIX = "erc-shell-";
const META_CACHE = "erc-offline-meta-v1";
const INVENTORY_URL = "/offline-assets.json";
const INDEX_URL = "/index.html";
const REPORT_KEY = "/__erc/install-report";
const INVENTORY_SCHEMA = 1;
/** Previous versions stay cached so open tabs keep their hashed bundles. */
const KEEP_VERSIONS = 2;

/**
 * Same-origin paths this worker installed, filled during install and refreshed
 * on activate. Populating it at install time is what lets the fetch handler
 * serve a precached asset from the cache without a network round trip, and it
 * is the ONLY list of paths the worker will ever serve from CacheStorage.
 */
let precachedPaths = new Set();

/* ------------------------------------------------------------- helpers --- */

/** Decode stored bytes and compare against the sha384 digest the build recorded. */
async function digestMatches(bytes, expected) {
  if (!expected || !expected.startsWith("sha384-")) return false;
  const hash = await crypto.subtle.digest("SHA-384", bytes);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return `sha384-${b64}` === expected;
}

async function readInventory() {
  // `no-store` so a half-updated worker can never install a stale asset list.
  const response = await fetch(INVENTORY_URL, { cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new Error(`inventory ${response.status}`);
  const parsed = await response.json();
  if (!parsed || parsed.schema !== INVENTORY_SCHEMA) throw new Error("inventory schema mismatch");
  if (!Array.isArray(parsed.assets) || parsed.assets.length === 0) throw new Error("inventory has no assets");
  return parsed;
}

async function writeReport(report) {
  const cache = await caches.open(META_CACHE);
  await cache.put(
    REPORT_KEY,
    new Response(JSON.stringify(report), { headers: { "Content-Type": "application/json" } }),
  );
}

async function readReport() {
  const cache = await caches.open(META_CACHE);
  const hit = await cache.match(REPORT_KEY);
  if (!hit) return null;
  return hit.json();
}

/**
 * The whole fetch policy, in one pure function so the rules are reviewable
 * without tracing event handlers.
 *
 * `immutable` covers both Vite's content-hashed /assets/ bundles and the
 * precached vendor paths (/pdfjs/*, /inspector/*): for each, the URL changes
 * when the bytes change, so a cached hit is always the right answer and the
 * request may be stored. Anything else on the origin is passed straight
 * through — in particular a same-origin API endpoint is never cached.
 */
function shouldIntercept(request, url, precached) {
  if (request.method !== "GET") return { handle: false, why: "non-GET" };
  if (url.origin !== self.location.origin) return { handle: false, why: "cross-origin" };
  if (request.headers.has("authorization")) return { handle: false, why: "authorization" };
  if (request.mode === "navigate") return { handle: true, kind: "navigation" };
  if (url.pathname.startsWith("/assets/")) return { handle: true, kind: "immutable" };
  if (precached.has(url.pathname)) return { handle: true, kind: "immutable" };
  return { handle: false, why: "not-precached" };
}

/* ------------------------------------------------------------- install --- */

async function precacheAll(inventory) {
  const cacheName = `${CACHE_PREFIX}${inventory.appVersion}`;
  precachedPaths = new Set(inventory.assets.map((asset) => new URL(asset.url, self.location.origin).pathname));
  const cache = await caches.open(cacheName);
  const installed = [];
  const errors = [];
  let bytes = 0;

  for (const asset of inventory.assets) {
    try {
      const response = await fetch(asset.url, { cache: "no-store", credentials: "omit" });
      if (!response.ok) throw new Error(String(response.status));
      const bytesOut = await response.arrayBuffer();
      await cache.put(asset.url, new Response(bytesOut, { headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/octet-stream" } }));

      // Verify the bytes that are IN THE CACHE, not the bytes that arrived:
      // readiness must describe stored state (Section 19, install manifest).
      const stored = await cache.match(asset.url);
      const storedBytes = await stored.arrayBuffer();
      const verified = await digestMatches(storedBytes, asset.integrity);

      installed.push({
        id: asset.id,
        url: asset.url,
        version: asset.version,
        integrity: asset.integrity,
        bytes: asset.bytes,
        required: asset.required !== false,
        verified,
      });
      if (verified) bytes += asset.bytes;
    } catch (error) {
      // One bad asset must not abort the whole install: Section 20 requires a
      // partial asset download to be a testable, reportable state.
      errors.push({ url: asset.url, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const report = {
    appVersion: inventory.appVersion,
    cacheName,
    installed,
    errors,
    verifiedBytes: bytes,
  };
  await writeReport(report);
  return report;
}

/* ------------------------------------------------------------- activate --- */

async function pruneOldCaches(keep) {
  const names = await caches.keys();
  const shells = names.filter((n) => n.startsWith(CACHE_PREFIX)).sort();
  const doomed = shells.slice(0, Math.max(0, shells.length - KEEP_VERSIONS));
  for (const name of doomed) {
    if (keep.includes(name)) continue;
    await caches.delete(name);
  }
  return doomed;
}

/* --------------------------------------------------------------- fetch --- */

self.addEventListener("install", (event) => {
  // No skipWaiting(): Section 19 forbids forcing an update during reading.
  // The page asks for it explicitly through erc:skip-waiting after the user
  // agrees a reload (reduceInstall's agree-reload).
  event.waitUntil(
    (async () => {
      const inventory = await readInventory();
      await precacheAll(inventory);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const report = await readReport();
      const keep = report ? [report.cacheName] : [];
      await pruneOldCaches(keep);
      // A restarted worker has an empty in-memory list; rebuild it so the
      // vendor paths stay cache-first after an update.
      try {
        const inventory = await readInventory();
        precachedPaths = new Set(inventory.assets.map((asset) => new URL(asset.url, self.location.origin).pathname));
      } catch {
        // No inventory: precachedPaths stays empty and only navigations and
        // hashed /assets/ bundles are served from cache.
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const decision = shouldIntercept(event.request, url, precachedPaths);

  // Everything the policy declines is passed through untouched: not read from
  // cache, not written to cache, not even delayed.
  if (!decision.handle) return;

  if (decision.kind === "navigation") {
    // Network first so a reload sees a new shell; fall back to the cached
    // entry point so an offline deep link still opens (Section 20).
    event.respondWith(
      (async () => {
        try {
          return await fetch(event.request);
        } catch {
          const cache = await caches.open((await readReport())?.cacheName ?? "");
          const shell = cache ? await cache.match(INDEX_URL) : null;
          if (shell) return shell;
          return new Response("offline", { status: 503, headers: { "Content-Type": "text/plain" } });
        }
      })(),
    );
    return;
  }

  // Content-hashed bundles and precached assets: cache first. The URL changes
  // when the bytes change, so a cached hit is always the right answer.
  event.respondWith(
    (async () => {
      const report = await readReport();
      const cache = await caches.open(report?.cacheName ?? "");
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const response = await fetch(event.request);
      if (response.ok && response.type === "basic") await cache.put(event.request, response.clone());
      return response;
    })(),
  );
});

/* ------------------------------------------------------------- messages --- */

self.addEventListener("message", (event) => {
  const data = event.data ?? {};
  const reply = (payload) => {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(payload);
    else if (event.source) event.source.postMessage(payload);
  };

  if (data.type === "erc:status") {
    event.waitUntil(
      (async () => {
        const report = await readReport();
        reply({ type: "erc:status", report });
      })(),
    );
    return;
  }

  if (data.type === "erc:skip-waiting") {
    // Only reached after the user agreed a reload.
    self.skipWaiting();
    reply({ type: "erc:skip-waiting", ok: true });
    return;
  }

  if (data.type === "erc:reinstall") {
    event.waitUntil(
      (async () => {
        const inventory = await readInventory();
        await caches.delete(`${CACHE_PREFIX}${inventory.appVersion}`);
        const report = await precacheAll(inventory);
        reply({ type: "erc:reinstall", report });
      })(),
    );
  }
});
