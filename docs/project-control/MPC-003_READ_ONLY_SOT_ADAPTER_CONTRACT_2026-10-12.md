# MPC-003 — Read-only GitHub/SOT adapter contract (SOURCE/QA candidate)
Authority: MAGASIN PROJECT CONTROL SOT; Supervisor operational authority remains the root SOURCE_OF_TRUTH.md.
This is a source/QA-only implementation candidate, **not an approved runtime deployment or Owner acceptance**.

## Entrypoint and allowed sources
`src/control-center/project_sot_adapter.mjs` exports `APPROVED_SOT_SOURCES` and `createReadOnlySotAdapter(options)`. Sources are fixed to:
- supervisor: magasincoffee/magasin-supervisor, SOURCE_OF_TRUTH.md
- workforce: magasincoffee/magasincoffee.github.io, 01_DOCS/MAGASIN/05_SYSTEM/WORKFORCE_CROSS_STORE_SCHEDULING_TEMP_SOURCE_OF_TRUTH.md
- print_ops: magasincoffee/OPS-WebApp, SOURCE_OF_TRUTH.md

The adapter does not accept arbitrary repository names, paths, hosts, GitHub redirects, or user-supplied SOT URLs. Only server-injected GET requests to GitHub REST are made. An optional token belongs on the server only; no browser/UI route is wired in MPC-003. Repositories stay independently governed; OPS is metadata read-only, with no shared RBAC, DB or dispatch.

## Read contract
`adapter.read(projectId,{expectedSha?})` fetches `commits/main`, then `contents/<allowlisted-path>?ref=<immutable-sha>`, then rechecks `commits/main`. `expectedSha` is the independent reference revision used to fail on a changed main when supplied. Success returns status `CURRENT`, pinned revision and raw SOT content **only**. The adapter cannot derive task completion, release acceptance or transport status from raw text. MPC-002 projection validation remains independent.

Failure outcomes explicitly include `NOT_ALLOWED`, `BAD_REVISION`, `NOT_FOUND`, `RATE_LIMIT`, `ACCESS_DENIED`, `MAIN_DIVERGED`, `BAD_CONTENT`, `BAD_RESPONSE`, `UPSTREAM_ERROR`, `NETWORK_ERROR`, `TIMEOUT` and `STALE`. A read carrying expectedSha always rechecks live main even within cache TTL, and MAIN_DIVERGED stays explicit. Cached snapshots are frozen at rest; callers receive independent source/revision copies, so returned-object mutation cannot poison cache. Malformed HTTP 200 JSON is BAD_RESPONSE with no retry. A cache entry past TTL is never returned as current; if refresh fails, `STALE` records the original reason with `content:null`. No 404, rate limit or divergent main silently turns into VERIFIED_DONE. No retries for 403/404/429; transient failures retry at most twice with short bounded backoff. Request timeout and decoded SOT bytes are bounded. The in-memory cache is per adapter instance and TTL controlled; it is not persisted.

## QA and release conditions
Run `node --test test/mpc003-readonly-sot-adapter.test.mjs` for synthetic allowlist/isolation, GET-only, bounded caching/retry, 404, 429/403, stale, malformed payload, and main-diverged fixtures. Required hosted Supervisor Tests, Integrity, Lifecycle Acceptance, Autostart Install must all succeed at exact PR head, followed by independent reviewed merge and exact-main verification. No project selection, Supervisor START/STOP, H4 apply, Owner write endpoint, production dispatch, hosted release or canonical SOT automation is authorized.
