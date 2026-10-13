# MPC-006 — Owner request draft capture, source and QA contract
Date: 2026-10-13 Asia/Ho_Chi_Minh
Task: MPC-006; root SOURCE_OF_TRUTH.md is the sole project authority.
Status: SOURCE CANDIDATE; NOT DEPLOYED OR OWNER ACCEPTED.

## Owner outcome
Select a known task in the Vietnamese Project Control tree, type the desired change (20–2500 characters), choose LOW/NORMAL/HIGH and optionally attach up to three GitHub screenshot links. These are REFERENCES ONLY; the browser does not upload binary content. Receive a durable pending-review receipt after authenticated submission. UI is responsive, keyboard navigable and escapes user text.

Every accepted intent is strictly PENDING_OWNER_REVIEW, never APPROVED, READY, STARTED, or VERIFIED_DONE. It never writes project SOT, dispatches jobs, selects projects, triggers business actions, starts Supervisor or removes STOP/AUTOSTART_DISABLED. Intent-to-technical-task mapping is solely MPC-007.

## Security architecture and locked-by-default use
- Control Center /api/overview CSRF is not proof of Owner identity. A separate Owner-only login session is needed, with PBKDF2 password verifier, short-lived HttpOnly SameSite=Strict cookie (scoped /api/owner), a per-session CSRF token plus the existing Origin/Host/CSRF boundary. Client-supplied role or username is never accepted.
- Runtime is LOCKED by default. Source contains no password and no default account. To qualify it at a separately approved local deployment gate, an authorized operator must provision MPC_OWNER_PASSWORD_VERIFIER using pbkdf2_sha256$310000$<salt hex 16+ bytes>$<digest hex 32 bytes>, and MPC_OWNER_REQUESTS_DB pointing to a pre-existing private absolute-path directory. No values are provisioned by this PR. Never commit credential verifiers or personal request data.
- Sessions live only in the Control Center process and expire after 30 minutes. Password checks have a bounded failure-rate lockout. A restart requires logging in again. Existing local-only interface 127.0.0.1:8781 is not accessible directly from an Owner mobile phone; this work does NOT qualify remote exposure, tunnel or mobile authentication.
- Local browser presence, a generic Owner header or a CSRF token alone are NEVER authentication.

## Requests, images, storage and proof
- The server revalidates requested project/feature/task IDs against its own navigational catalogue, not a client-provided SOT or READY state. The catalogue is still LOCAL_UNVERIFIED.
- Only exact payload keys; bounded UTF-8 text, selected priority and up to three immutable-shaped github.com/user-attachments/assets UUID links. No direct uploads, arbitrary URLs, scraping, credentials or screenshot media bytes.
- Private SQLite inserts immutable request and append-only audit event atomically; unique Owner+idempotency UUID key and SHA-256 of normalized payload permit a safe identical retry, while a changed payload with the same key gets HTTP 409. Database triggers reject updates/deletes. No request can be mistaken for Owner approval or dispatched work.
- Browser retains unsent text across polling and reuses the same request key after an uncertain submission. Only authenticated sessions see the form. The result always states pending-review, not approved or running.

## Source boundaries
Backend module: src/control-center/owner_request_drafts.py.
Existing localhost server: src/control-center/server.py with GET /api/owner/session and POST /api/owner/login, /api/owner/requests, /api/owner/logout.
Browser: src/control-center/web/project_request_view.mjs, project_tree_view.mjs, app.js and styles.css.
Fixtures: test/test_mpc006_owner_requests.py, test/test_mpc006_owner_http.py, test/mpc006-owner-request-ui.test.mjs.

## Acceptance sequence
1. Targeted synthetic Python and Node QA: missing/invalid identity, Origin and both CSRF guards, session timeout/logout, failed-login lockout, forged task, URL XSS, path or symlink denial, duplicate exact-once and SQLite append-only audit.
2. Validate real loopback HTTP endpoints against temp fixtures on Windows and Linux only, never against actual H4.
3. Four mandatory hosted Supervisor workflows GREEN on EXACT final PR HEAD; one independent Codex review of the finished complete task; grouped P1/P2 repairs only when needed; reviewed merge and exact-main.
4. Separate Owner approval for any hash-pinned H4 stage/apply, credential provisioning, external mobile access, live acceptance or production writes. This task cannot grant those actions.

No automatic Worker, GitHub dispatch, request-to-SOT writeback, cross-project authority or any Supervisor START is introduced. MPC-007 remains separately gated.
