# Hosting headers

Production static-host config for the PWA. This directory is owned by the
delivery track (H); A owns the build config that copies `public/` into `dist/`.

`./_headers` uses Cloudflare Pages / Netlify syntax. On hosts without
`_headers` support the same directives translate directly:

| Directive | `_headers` | nginx | Netlify `_headers` |
| --- | --- | --- | --- |
| Per-path headers | `/*` | `location /` | same file |
| MIME types | `/assets/*.wasm` | `types { }` | same file |
| Immutable caching | `Cache-Control` | `add_header` | same file |

`public/_headers` is the authority and this file explains it. Every rationale
below is duplicated as a comment in `_headers` itself, so an editor who opens
only that file cannot widen the policy by accident.

## The Content-Security-Policy, directive by directive

Shipped policy, in full:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';
child-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
font-src 'self'; connect-src 'self' https://api.anthropic.com;
manifest-src 'self'; base-uri 'none'; form-action 'none';
object-src 'none'; frame-src 'none'; frame-ancestors 'none'
```

- **`default-src 'self'`** — anything not named below is same-origin only.
  One origin of trust, no third-party fallbacks.

- **`script-src 'self' 'wasm-unsafe-eval'`** — self-hosted scripts only; no
  CDN, no inline. `'wasm-unsafe-eval'` is the narrow allowance that
  `WebAssembly.compile` / `instantiateStreaming` require for the inspector WASM
  (Track E). It is **not** `'unsafe-eval'`: `eval()`, `new Function()` and
  string timers stay blocked. `tests/pwa/headers.test.ts` asserts both halves
  of that — that the directive is exactly these two sources, and that the bare
  token `unsafe-eval` appears nowhere in the policy. If the WASM path is ever
  dropped, remove the allowance with it.

- **`worker-src 'self'`** — both workers are same-origin module workers:
  `public/sw.js`, `public/pdfjs/pdf.worker.mjs`, and the Track E inspector
  worker.

  **`blob:` is deliberately absent.** Section 18 permits a Blob/frame
  exception "only when proven necessary by actual integration tests", so the
  claim was checked rather than assumed:

  ```
  $ grep -o "createObjectURL\|new Blob\|new Worker\|WebAssembly\.[a-z]*" \
      public/inspector/pdf_inspector_wasm.js | sort | uniq -c
        3 WebAssembly.instantiate
        3 WebAssembly.instantiateStreaming
        2 WebAssembly.Instance
        2 WebAssembly.Module
  ```

  The inspector glue fetches its `.wasm` and calls
  `WebAssembly.instantiateStreaming`; it never constructs a Blob URL or a nested
  Worker. `pdf.worker.mjs` is loaded by URL, not by blob. Neither path needs
  `blob:`, so it is not granted. Re-add it only alongside the integration test
  that demonstrates the need — not on suspicion.

- **`connect-src 'self' https://api.anthropic.com`** — a **placeholder pending
  Track G** (Section 22.5: H coordinates CSP destinations with G). No transport
  is implemented and no request is made today; see
  `docs/known-limitations.md` §4. Replace the host when G lands the transport.
  Do not add arbitrary origins, wildcard subdomains, or a proxy that forwards
  anywhere — Section 18 rules out an arbitrary endpoint picker.

- **`style-src 'self' 'unsafe-inline'`** — React sets style attributes inline.
  Scripts get **no** inline allowance at all; only styles do.

- **`font-src 'self'`, `manifest-src 'self'`, `img-src 'self' data:`** — the
  standard fonts and CMaps are served from our own origin (Section 18 forbids
  remote document resources); `data:` covers inline icons only.

- **`object-src 'none'`, `frame-src 'none'`, `frame-ancestors 'none'`** — no
  plugins, no remote documents, no embedding of this app.

- **`base-uri 'none'`, `form-action 'none'`** — no base-tag hijack, no form
  exfiltration.

- **`child-src 'self'`** — the worker fallback chain, same-origin only.

## Hardening baseline

- **`X-Content-Type-Options: nosniff`** — required, not decorative. It is what
  makes a wrong MIME type fail closed instead of degrading quietly, which is
  why the MIME map below is explicit.
- **`Referrer-Policy: no-referrer`** — reading positions and dictionary queries
  are not useful to third parties.
- **`Strict-Transport-Security`** — HTTPS only, two years, subdomains, preload.
- **`Permissions-Policy`** — camera, microphone, geolocation and FLoC-style
  cohort signals all denied. A reading app needs none of them.

## Caching rule

One rule, applied consistently:

- **content hash in the filename → immutable.** Vite emits the app shell into
  `/assets/index-<hash>.js`, so `/assets/*` gets
  `max-age=31536000, immutable`.
- **stable URL that the build regenerates → revalidate.** The vendored runtime
  and the generated inventory use stable paths, so they get `no-cache`.

This distinction matters: marking `/pdfjs/*` or `/inspector/*` immutable would
pin every install to whatever bytes the first response happened to return,
even after a dependency upgrade. They are stable paths, so they revalidate.

| Path | Policy | Reason |
| --- | --- | --- |
| `/assets/*` | `max-age=31536000, immutable` | Vite content-hashed output |
| `/index.html`, `/sw.js`, `/manifest.webmanifest` | `no-cache` | the mutable entry points |
| `/offline-assets.json` | `no-cache` | records byte counts and digests; a stale copy would make readiness compare the cache against yesterday's build |
| `/icons/*` | `no-cache` | regenerated each build, under 2 KB |
| `/pdfjs/*`, `/inspector/*` | `no-cache` | vendored, stable paths, must revalidate |

## MIME types

`.wasm` → `application/wasm` and `.mjs`/`.js` → `text/javascript; charset=utf-8`
are declared for both `/assets/` (Vite output) and `/pdfjs/`, `/inspector/`
(the vendored runtime the precache depends on). CMaps get
`application/octet-stream`, TrueType `font/ttf`, PFB `application/octet-stream`.

Most hosts already map these. They exist because Section 21 makes worker and
WASM paths a release gate, and under `nosniff` a wrong type fails closed
rather than degrading.

## Service-worker caching rules

Encoded in the install manifest and readiness logic
(`src/pwa/manifest.ts`, `public/sw.js`), not in this file:

- Originals live in IndexedDB. Never in a service-worker response cache.
- AI POST responses are never cached through the service worker: the worker
  declines to intercept any non-GET request at all, and never stores a request
  carrying an `Authorization` header.
- Same-origin API endpoints are never cached — only navigations,
  content-hashed `/assets/*`, and paths the inventory actually installed.

See `docs/offline-delivery.md` §5 for the full table.

## Tests

`tests/pwa/headers.test.ts` parses this directory's `_headers` file and asserts
the policy above. It reads the real file rather than restating the rules, so a
loosened header fails CI instead of shipping. It covers CSP directives, cache
immutability, and the MIME map.

It does **not** prove a given host applies them — that needs the
production-like hosting check from Section 21, which is not implemented yet
(`docs/known-limitations.md` §1).
