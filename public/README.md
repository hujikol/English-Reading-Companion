# Hosting headers

Production static-host config for the PWA. Track H owns this file; A owns the
build config that copies `public/` into the bundle.

`../_headers` uses Cloudflare Pages / Netlify syntax. On hosts without
`_headers` support the same directives translate directly:

| Directive | `_headers` | nginx | Netlify `_headers` |
| --- | --- | --- | --- |
| Per-path headers | `/*` | `location /` | same file |
| MIME types | `/assets/*.wasm` | `types { }` | same file |
| Immutable caching | `Cache-Control` | `add_header` | same file |

## What each directive is for

`Content-Security-Policy` — restrictive by default:

- `default-src 'self'`, so anything not listed below is same-origin only.
- `script-src 'self' 'wasm-unsafe-eval'` — self-hosted scripts only.
  `'wasm-unsafe-eval'` is required by `WebAssembly.compile` for the inspector
  WASM (Track E) and is **not** `'unsafe-eval'`; arbitrary `eval()` stays
  blocked. Remove it only if the WASM path is dropped entirely.
- `style-src 'self' 'unsafe-inline'` — React sets style attributes inline.
  Scripts get no inline allowance.
- `worker-src 'self'`, `child-src 'self'` — the PDF worker (Track B) is
  same-origin. No third-party worker source.
- `object-src 'none'`, `frame-src 'none'`, `frame-ancestors 'none'` — no
  remote documents, plugins, or embedding.
- `base-uri 'none'`, `form-action 'none'` — no base-tag hijack, no form
  exfiltration.
- `font-src 'self'`, `manifest-src 'self'`, `img-src 'self' data:` — fonts and
  CMaps are served from our origin; `data:` covers inline icons only.
- `connect-src 'self' https://api.anthropic.com` — **placeholder pending Track
  G** (Section 22.5: H coordinates CSP destinations with G). Replace the API
  host when the transport lands. Do not add arbitrary origins, wildcard
  subdomains, or a proxy that forwards anywhere.

`X-Content-Type-Options: nosniff` — required, not optional: it is what makes a
wrong MIME type fail closed instead of degrading quietly.

`Referrer-Policy: no-referrer` — reading positions and dictionary queries are
not useful to third parties.

`Strict-Transport-Security` — HTTPS only, two years, subdomains.

`Permissions-Policy` — camera, microphone, geolocation, and FLoC-style cohort
signals all denied. A reading app needs none of them.

## Caching

- `/assets/*` — Vite emits content-hashed filenames, so `max-age=31536000,
  immutable` is safe and is what makes the offline install cheap to re-check.
- `/index.html`, `/sw.js`, `/manifest.webmanifest` — `no-cache`. The worker
  script must revalidate or updates can never be discovered.

## MIME types

`.wasm` → `application/wasm` and `.mjs`/`.js` → `text/javascript; charset=utf-8`
are declared explicitly because Section 21 makes worker and WASM path testing a
release gate. Most hosts already map these; the declarations exist so the
production-like smoke test has something to assert against.

## Service-worker caching rules

Encoded in the install manifest and readiness logic (`src/pwa/manifest.ts`),
not in this file:

- Originals live in IndexedDB. Never in a service-worker response cache.
- AI POST responses are never cached through the service worker, and
  credentials are never cached.

## Tests

`tests/pwa/headers.test.ts` parses this directory's `_headers` file and asserts
the policy above. It reads the real file rather than restating the rules, so a
loosened header fails CI instead of shipping. It covers CSP directives, cache
immutability, and the MIME map; it does not prove a given host applies them —
that needs the production-like hosting check from Section 21.