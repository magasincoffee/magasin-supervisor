# MPC-003 — Bounded, allowlisted GitHub/SOT reader (SOURCE/QA ONLY)

## Authority and integration
The canonical SOT of each domain remains the only authority. The Supervisor root `SOURCE_OF_TRUTH.md` continues to govern SC-013. `MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md` governs this subordinate project backlog only. This module is an isolated server-side read utility, **not** a public route, autonomous adapter dispatcher, or verified progress projection; integration and Owner UI are later gates.

`src/control-center/project_sot_reader.mjs` exports `createProjectSotReader`, `PROJECT_SOT_SOURCES`, and `SOT_READ_STATUSES`. Call `const result = await reader.read(sourceId, { expectedSha })` using a known immutable 40-hex-character main SHA obtained by an authorized, trusted upstream caller. The API `fetchImpl` is injectable so a future authorized server-side transport may use its existing GitHub credentials without placing a token in browser code, model output, logs, or UI. The module itself does not store credentials.

Allowlisted sources (only):
- `supervisor`: `magasincoffee/magasin-supervisor` / `SOURCE_OF_TRUTH.md`
- `workforce`: `magasincoffee/magasincoffee.github.io` / `01_DOCS/MAGASIN/05_SYSTEM/WORKFORCE_CROSS_STORE_SCHEDULING_TEMP_SOURCE_OF_TRUTH.md`
- `print_ops`: `magasincoffee/OPS-WebApp` / `SOURCE_OF_TRUTH.md`

Repo URLs, paths, branch names, and hosts cannot be overridden by discovery input; arbitrary user-provided SOT links are **not trusted**. OPS-WebApp data/auth/operations remain independent and link-only. Non-allowlisted sources are `INVALID_SOURCE`, not dynamically accepted.

## Read-only and failure gates
Every network operation is an explicit `GET` to `https://api.github.com` for `commits/main` or `contents/<fixed path>?ref=<expectedSha>`. First compare live main commit SHA with the caller's pinned expected SHA. Fetch immutable content, enforce a 512-KiB UTF-8/base64 limit, and check main SHA again before serving. Content never confers completion; `verified: false` on success. No SOT parsing, `VERIFIED_DONE` conclusion, task dispatch, project switch, mutation, authenticated Owner action, or Supervisor START/STOP change occurs.

Status results are `OK`, `INVALID_SOURCE`, `MAIN_DIVERGED`, `NOT_FOUND`, `RATE_LIMITED`, `ACCESS_DENIED`, `STALE`, `UNAVAILABLE`, `INVALID_RESPONSE`. Every failure has `content: null`. No silent success or cached fallback for missing/rate-limited/divergent data. Network and retryable 5xx failures have at most 3 attempts with bounded backoff; `404`, `401`, `403`, `429`, and malformed content do not retry. Each individual request has a bounded timeout, cache at most 32 entries and a TTL no more than 60 seconds. Even on cache HIT, live `main` is checked. On an expired cached result and network failure, return `STALE` without exposing stale contents; when `main` differs, return `MAIN_DIVERGED` immediately.

## QA and release boundaries
Targeted QA: `node --test test/mpc003-project-sot-reader.test.mjs`; run before hosted CI. The tests exercise allowlist/SSRF denial, GET-only, SHA-pinning, cache/expiry, retry caps, main divergence before and during fetch, 404, rate limit, offline stale, malformed/oversized content, and OPS separation. Both `Supervisor Tests` and `Supervisor Integrity` must invoke these fixtures, followed by **all four** mandatory hosted Supervisor workflows GREEN at the exact PR head, independent review, reviewed merge and exact-main readback.

No deployment to H4, new runtime endpoint, production operation, or Owner acceptance is included. Supervisor remains STOPPED/AUTOSTART_DISABLED until its independent authorization gates.