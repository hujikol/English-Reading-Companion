# Offline delivery

How the PWA becomes installable and works offline. Sections 19 (delivery),
16 (budgets), 18 (security) and 13 (persistence).

Read `docs/known-limitations.md` alongside this: the machinery below is real
and verified, and the features that would consume it are not built yet.

---

## 1. The one idea

> **"Ready offline" is a claim about verified bytes, never about shell caching.**

Three files hold that line, and none of them duplicates each other:

| File | Sole job |
| --- | --- |
| `src/pwa/offline-assets.ts` | declares which assets must be installed, and maps the build inventory into the manifest shape |
| `src/pwa/manifest.ts` (existing, Track H-tested) | `computeReadiness()` — decides ready / missing / mismatched / unverified |
| `src/pwa/install.ts` (existing, Track H-tested) | `reduceInstall()` — phases; never forces an update during reading |

`src/pwa/sw-registration.ts` wires them together. It cannot invent a readiness
result: an absent, partial or tampered install report yields a `Readiness` whose
`missing` list covers every required asset, and `computeReadiness` refuses to
return `readyOffline` when `requiredCount` is 0. There is no branch anywhere
that says "the shell is cached, call it ready".

The service worker (`public/sw.js`) deliberately contains **no readiness logic**.
It moves bytes and measures digests. If it also decided readiness, the product
would have two disagreeing sources of truth for its most safety-relevant
string.

---

## 2. Layout

```
public/
  sw.js                 service worker (static, no build step — see §4)
  _headers              CSP, cache and MIME policy (see public/README.md)
  pdfjs/cmaps/          168 .bcmap + LICENSE   vendored from pdfjs-dist@5.4.149
  pdfjs/standard_fonts/ 14 faces + 2 licence files
  inspector/pdf_inspector_wasm.js         vendored from @firecrawl/pdf-inspector-wasm@1.25.2
  inspector/pdf_inspector_wasm_bg.wasm

src/pwa/
  offline-assets.ts         declaration + inventory types (browser-safe)
  offline-assets.build.ts   Node 24 generator: inventory, icons, budget checks
  sw-registration.ts        registration, readiness, install/reload agreement

dist/                       build output (gitignored)
  offline-assets.json       GENERATED — the precache inventory
  manifest.webmanifest      GENERATED
  icons/                    GENERATED
```

### Vendored assets were copied out of `node_modules`

They are committed to `public/` on purpose. Section 19 requires self-hosted
assets before Ready offline, and Section 18 requires pinned assets with
integrity checks; resolving them through the bundler at build time would leave
the offline path dependent on a bundler decision at runtime. The copies are
digest-checked at install time, so a drifted copy fails verification rather
than quietly serving stale bytes.

### The paths were chosen, not inherited

`src/features/reader/pdf/adapter.ts` (Track B) specifies `public/pdfjs/` for
the worker, CMaps and standard fonts, and this track uses exactly those paths.
The inspector assets go to `public/inspector/`. No conflict with either track.

---

## 3. Real byte totals

Measured, not estimated. `node src/pwa/offline-assets.build.ts inventory`:

```
offline inventory 0.0.0 — 197 files
  pdfjs-cmaps              169 files     1.11 MiB raw    957.9 KiB gzip  budget=offlineInstall ok
  pdfjs-standard_fonts       16 files   762.0 KiB raw    529.8 KiB gzip  budget=offlineInstall ok
  inspector-wasm              1 files     5.72 MiB raw     2.47 MiB gzip  budget=inspectorWasm ok
  inspector-glue              1 files    22.4 KiB raw       4.8 KiB gzip  budget=inspectorWasm ok
  shell                       7 files   275.7 KiB raw      91.1 KiB gzip  budget=shellTransfer ok
  lazy-chunks                 3 files     1.35 MiB raw    403.0 KiB gzip  budget=pdfEngine ok
  TOTAL                     197 files     9.22 MiB raw     4.41 MiB gzip  budget=offlineInstall ok
```

**Exact: 9,665,963 bytes raw (9.22 MiB), 4,619,572 bytes compressed (4.41 MiB).**

Compressed figures are per-file `zlib -9`, i.e. a conservative upper bound —
they sum 169 separately-compressed CMap files rather than one archive.

### The PDF worker is precached exactly once

`src/ui/reader/pdfEngine.ts` loads the worker with Vite's
`import("pdfjs-dist/build/pdf.worker.mjs?worker")`, which emits it as its own
content-hashed chunk under `/assets/`. A hand-copied second copy at
`/pdfjs/pdf.worker.mjs` was initially precached as well and cost **1.80 MiB
raw / 362 KiB gzip of bytes no code path loads**. It has been removed; a test
now fails if a second worker copy ever reappears. CMaps and standard fonts are
different: `pdfEngine.ts` fetches those from `/pdfjs/`, so they are genuinely
served from `public/`.

### Why every group is included, and the cost of dropping it

| Group | Raw | Gzip | Kept because | If dropped |
| --- | ---: | ---: | --- | --- |
| `lazy-chunks` | 1.35 MiB | 403.0 KiB | The PDF.js engine + worker chunk. No PDF renders without it. | Total PDF support disappears |
| `pdfjs-cmaps` | 1.11 MiB | 957.9 KiB | Non-embedded CJK fonts fall back to blank or mojibake text | −958 KiB, breaks some CJK PDFs |
| `pdfjs-standard_fonts` | 762.0 KiB | 529.8 KiB | PDFs without embedded fonts render blank. Common in older/scientific files. | −530 KiB, breaks some PDFs |
| `inspector-wasm` | 5.72 MiB | 2.47 MiB | Semantic extraction. Section 19 requires it "when enabled" | −2.47 MiB, no semantics |
| `inspector-glue` | 22.4 KiB | 4.8 KiB | Loads the WASM. | — |
| `shell` | 275.7 KiB | 91.1 KiB | index.html, entry JS, entry CSS, manifest, 3 icons | — |

Budgets, per Section 16, with room in every line:

- shell 91.1 KiB gzip against the 500 KiB "total shell transfer" limit
  (and 88.9 KiB of JS against the 250 KiB "initial app shell JavaScript" limit).
- lazy PDF engine + worker 403.0 KiB against the 1.5 MiB target.
- inspector 2.47 MiB against the 5 MiB provisional target.
- **total offline install 4.41 MiB against the 20 MiB budget.**

**Budget mapping, stated because it is a judgement call:** Section 16 gives
fonts and CMaps no line of their own. They are charged to the total offline
install budget, not to the 1.5 MiB "lazy PDF engine and worker" line, which
the spec scopes to "engine and worker". Charging CMaps and fonts there would
have put the PDF group at 1.82 MiB and failed a budget it does not belong to.
The mapping lives in `BUDGET_BY_GROUP` in `src/pwa/offline-assets.ts` with the
reasoning in the comment.

**The honest caveat:** the 5.72 MiB WASM is 62% of the raw install and is not
yet reachable from any UI, because `src/document/adapter.ts` still wires
`FakeInspector`. It is kept because Section 19 requires it for the enabled
baseline and because the FG-WASM gate decides whether the WASM path is viable
at all — precaching it now means that decision does not become a second 5.7 MiB
install event later. If A approves a PDF.js-only scope exception, deleting the
two `inspector-*` rows and the directory saves 2.47 MiB compressed in one edit.

---

## 4. The service worker is plain JavaScript in `public/`

It must be served from `/sw.js` to hold root scope. Producing it from TypeScript
would mean adding a build input to `vite.config.ts`, which this track does not
own. So `public/sw.js` is static, with no imports and no build step — which is
also the most robust arrangement: nothing in the toolchain can break the worker
that makes the app installable.

The cost is that the worker cannot import `computeReadiness`. That is why the
readiness decision lives on the page instead, and it is a better arrangement
than the alternative: the policy stays in tested TypeScript where the rest of
the app's logic lives, and the worker stays small enough to read in one sitting.

---

## 5. What the worker will and will not touch

All fetch policy is in one pure function, `shouldIntercept()`, so it can be
reviewed without tracing handlers:

| Request | Intercepted | Why |
| --- | --- | --- |
| Non-GET (any method) | **Never** | AI calls are POSTs. They cannot be read from or written to a cache. |
| Cross-origin | **Never** | No third-party resource, ever (Section 18). |
| Carries `Authorization` | **Never** | A credential must not reach CacheStorage. |
| Navigation | Yes, network-first | Offline deep links fall back to the cached entry point. |
| `/assets/*` | Yes, cache-first | Vite content-hashed: a cached hit is always correct. |
| Precached vendor path | Yes, cache-first | Installed during `install`, in `precachedPaths`. |
| Anything else same-origin | **Never** | Includes any same-origin API endpoint. |

`tests/pwa/offline.test.ts` executes the real worker against a fake
CacheStorage and asserts the negative cases directly, because "never" is the
property that matters and is the one a future edit breaks silently.

Other invariants, all asserted:

- No `skipWaiting` in `install` — updates wait for the user (Section 19).
- Previous version caches are kept (`KEEP_VERSIONS = 2`) so open tabs keep
  resolving their hashed bundles.
- A single unreachable asset is recorded as an error and does not abort the
  install; readiness then reports the gap honestly.
- Digests are recomputed from the bytes **read back out of the cache**, not
  from the bytes that arrived. Readiness must describe stored state.

---

## 6. Build and verify

```bash
npm run build                                        # dist/ + vendored public/
node src/pwa/offline-assets.build.ts inventory       # write dist/offline-assets.json
node src/pwa/offline-assets.build.ts smoke           # verify budgets + digests + no drift
npx vitest run tests/pwa/                            # asserts against the built inventory
```

`inventory` also generates `dist/manifest.webmanifest` and the three install
icons (deterministic PNGs written with `node:zlib`; no image dependency added).

`smoke` fails when a declared URL has no file in `dist/`, when a digest drifted
from what was recorded, or when any Section 16 budget is exceeded.

`src/pwa/offline-assets.build.ts` runs directly under Node 24, which strips its
types. No transpile step, no dependency, and **nothing added to `package.json`**
(which this track does not own).

---

## 7. Regenerating the vendored assets

After a dependency bump, re-copy and re-verify:

```bash
cp node_modules/pdfjs-dist/cmaps/*                            public/pdfjs/cmaps/
cp node_modules/pdfjs-dist/standard_fonts/*                   public/pdfjs/standard_fonts/
cp node_modules/@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm.js     public/inspector/
cp node_modules/@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm public/inspector/
npm run build && node src/pwa/offline-assets.build.ts inventory
```

The PDF **worker** is not in that list on purpose: `?worker` emits it into
`/assets/`, and copying it would only create a second, unused copy. See §3.

Licence files inside `cmaps/` and `standard_fonts/` are copied with them. This
is also the moment to check whether `pdfjs-dist` changed its directory layout —
the generator's `VENDOR_ASSETS` table is the single place that needs editing,
and a missing file fails `inventory` loudly rather than silently dropping an
asset.

---

## 8. Quota recovery

`src/pwa/sw-registration.ts` routes a failed precache through the existing
`recoverFromQuota()` in `src/features/settings/storage/quota.ts` — it does not
implement recovery of its own:

1. On `QuotaExceededError`, evict **derived** tables only.
2. Retry the precache exactly once.
3. If it still fails, keep the session temporary.

`evictDerivedOnly()` re-checks `isEvictable()` at the moment of eviction, so a
future caller cannot pass a user table through by mistake. Only `semanticPages`
and `aiCache` are offered. `documents`, `assets`, `progress`, `bookmarks`,
`marks`, `vocabulary`, `occurrences`, `reviewCards`, `reviewEvents`,
`explanations` and `settings` are unreachable from the eviction path —
asserted in `tests/pwa/offline.test.ts`.

Original books are never in CacheStorage at all: they live in IndexedDB, and
the worker only ever caches same-origin static assets.

---

## 9. Related paths (owned by other tracks, referenced only)

- `src/app/App.tsx`, `src/ui/**` — app shell and UI. The web manifest still
  needs its `<link rel="manifest">` in `index.html`; see known-limitations §1.
- `src/contracts/**` — `ProducerTrack` needs `"A"` added for the shell
  attribution; flagged at `src/pwa/offline-assets.build.ts`.
- `vite.config.ts`, `package.json` — not edited by this track.