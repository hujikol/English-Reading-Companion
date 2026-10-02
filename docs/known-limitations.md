# Known limitations

Branch: `main`. Written during the A0 foundations work by the delivery track
(H): service worker, precache, hosting headers, CI.

This file exists because the alternative — a green CI badge next to a list of
capabilities the product does not have — is worse than useless for anyone
deciding whether to trust a release. Everything below is **currently true**.
Anything that stops being true must be removed from this file in the same
change that fixes it.

---

## 1. Delivery: what works offline today

The offline machinery is real and verified. The *content* it serves is not
complete.

| Capability | State | Evidence |
| --- | --- | --- |
| Installable PWA (HTTPS static app, manifest, icons, worker) | Works | `public/sw.js`, generated `dist/manifest.webmanifest` + `dist/icons/*.png` |
| Precache + digest verification of 197 assets | Works | `node src/pwa/offline-assets.build.ts smoke` |
| Ready-offline claim derived from verified state, not shell caching | Works | `computeReadiness()` in `src/pwa/manifest.ts`, asserted in `tests/pwa/offline.test.ts` |
| Update never forced during reading | Works | `reduceInstall()`; worker has no `skipWaiting` in `install` |
| Offline relaunch of the app shell | Works | worker `navigation` handler falls back to the cached entry point |
| **Opening and reading a PDF offline** | **Does not work yet** | no PDF reader UI is wired |
| **Semantic extraction from a PDF** | **Does not work yet** | `src/document/adapter.ts` wires `FakeInspector`; the real WASM path is unproven (FG-WASM) |

The shell opens offline. Nothing else does, because the features that would use
the precached assets are not built yet. The precache is ahead of the readers,
deliberately: the assets are pinned, hashed and budgeted now so that the
readers cannot silently fall back to a CDN.

### Known gaps in the delivery path itself

- **No real-browser offline test.** `tests/pwa/offline.test.ts` executes the
  real `public/sw.js` in Node against a fake CacheStorage. That proves the
  worker's policy, not Chrome's. Section 20 requires Playwright clean-install
  and offline-relaunch journeys; those are **not implemented**. Nothing in this
  repo has yet observed a browser going offline and coming back.
- **No install-UI test.** Section 19 notes installation UI varies by browser;
  basic web use must work without installation, and nothing here has been
  checked on a second browser engine.
- **`index.html` is not wired to the web manifest.** The manifest, icons and
  service worker all ship and all work, but `index.html` (owned by track A) has
  no `<link rel="manifest">` and no `<meta name="theme-color">`. Until that one
  line is added, **Chrome will not offer "Install app"**. This is a real gap,
  not a formality; it is a one-line change in a file this track does not own.
- **No production-like hosting check.** The CSP, MIME map and cache policy are
  asserted against the file, but no job has yet deployed to staging and
  verified that a host actually applies them. Section 21 makes that a release
  gate.

---

## 2. Dictionary: not installed

**No dictionary pack is installed or bundled.** `dictionaries/` is gitignored
and holds only a synthetic fixture pack used by tests.

Consequences, stated plainly:

- The local dictionary feature does not work. Selecting an unfamiliar word
  yields no local meaning.
- Section 9's advertised offline lookup is **not met**.
- FG-DICT is unresolved: the candidate artifact, licence and redistribution
  route are not settled. Section 2 forbids distributing an unlicensed pack, so
  nothing was guessed at here.
- The precache declares **no** `dictionary` asset kind. When a pack lands, it
  becomes an additional required-or-optional entry in the inventory; an unused
  pack must be `required: false` so it never blocks Ready offline (the rule
  already exists in `src/pwa/manifest.ts`).

---

## 3. EPUB renderer: missing

**EPUB can be validated but not read.** `src/features/reader/epub/` contains
package validation, zip-bomb checks, sanitisation and isolation policy. There is
no renderer, so an imported `.epub` opens nothing.

- Section 8's EPUB/TXT/Markdown read journeys are **not met**.
- FG-FORMAT is unresolved for hostile-content behaviour at D stage.

---

## 4. AI: not configured

**No AI provider is configured and no request is ever made.** There is no
endpoint, no key storage, and no transport.

- `connect-src 'self' https://api.anthropic.com` in `public/_headers` is a
  **documented placeholder pending track G**, not a live configuration. The app
  makes no request to it today.
- No credential is stored anywhere. The service worker never caches a request
  carrying an `Authorization` header and never intercepts a non-GET request at
  all — asserted in `tests/pwa/offline.test.ts`.
- FG-AI is unresolved. Section 2 permits "AI unavailable" as a product
  configuration, so this is a legal state, but it must be advertised as one.

---

## 5. Benchmarks: only delivery budgets are measured

Section 16 defines performance budgets and Section 17 defines a benchmark
plan. **Only the delivery-budget half is implemented**, because that is the
half measurable from build output in CI:

- shell JS gzip, total shell transfer, lazy PDF engine, inspector WASM,
  total offline install — enforced by `assertBudgets()` in
  `src/pwa/offline-assets.build.ts` and asserted in `tests/pwa/offline.test.ts`.

Not implemented, and deliberately not faked:

- Section 17's corpus (30+ documents, 200+ labelled selection/context cases).
- First readable PDF page, reopen latency, local lookup, semantic context,
  save-vocabulary and selection-response budgets.
- Memory measurement, 20-minute scrolling leak session, device/browser matrix.
- The 15% regression flagging Section 21 asks for.

The `benchmark-smoke` CI job runs the delivery-budget check and **only** that.
Its job name says "benchmark smoke (delivery budgets)" so a green run cannot be
read as "the performance budgets passed".

---

## 6. npm audit: 5 dev-only advisories, deferred

`npm audit` reports **5 findings**, all in the development toolchain, none in
shipped application code:

| Package | Severity | Reachable by |
| --- | --- | --- |
| `vitest` | critical | local test server / Vitest UI |
| `vite` | high | local dev server, Windows-only UNC path handling |
| `@vitest/mocker` | moderate | redirect mock, dev only |
| `vite-node` | moderate | dev only |
| `esbuild` | moderate | dev server request handling |

Verified: `npm audit --omit=dev` reports **0** production vulnerabilities. None
of these packages are bundled into `dist/`; they run only on a developer's
machine.

**Recommended fix is a breaking upgrade: `vite` 8.3.2 and `vitest` 5.0.3.**
Both are major bumps that will require changing `vite.config.ts`, the vitest
setup and the build scripts.

**Recommendation: defer until the test suite is stable.** Reasons, in order:

1. The suite is still being written by several tracks in parallel. A major
   vitest bump changes the runner every one of those tests depends on; doing it
   now means resolving upgrade noise and feature work in the same diff.
2. The exposure is a local development server. It is not reachable by a user of
   the deployed app.
3. The upgrade is not free: vite 8 changes the build API and vitest 5 changes
   the mocking and environment APIs that the existing tests use.

**Reconsider immediately if** any of these become true: the app ships a hosted
dev/preview server; a contributor-facing preview URL is exposed; or track A
opens the desktop work, which changes the build toolchain anyway.

This is the "explicit, time-bounded exception" Section 21 requires. It is
recorded here, enforced in `.github/workflows/ci.yml` (production audit blocks,
dev audit reports without blocking), and should be revisited before any release.