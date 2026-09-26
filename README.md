# MAGASIN Supervisor

Local autonomy runtime for MAGASIN projects.

## Canonical authority

### Current production truth

Production remains on the released **Three-Lane V1** runtime until a separately Owner-authorized V3 cutover. This repository change does **not** deploy, hotpatch, restart Chrome, or mutate local production state.

Historical release/qualification evidence remains in the MIG and Three-Lane evidence files under `docs/`. Those records are audit/rollback provenance, not current architecture authority.

### Approved target architecture

The only active forward architecture/source-of-truth is:

- `docs/SUPERVISOR_SINGLE_LANE_CHATGPT_FIRST_V3_SOURCE_OF_TRUTH.md`
- `docs/SUPERVISOR_SINGLE_LANE_CHATGPT_FIRST_V3_SOURCE_OF_TRUTH.json`

Target: **Single-Lane ChatGPT-First Runtime V3**.

Key decisions:

- ChatGPT Plus is the center of the system.
- Exactly one active project and one active task.
- Exactly two persistent warm ChatGPT targets: Brain + Work.
- Normal path is event-driven; polling is not the primary completion detector.
- Preferred browser fast path is a Chrome extension/content-script event bridge with local transport.
- Direct bounded DOM actions handle send/retry/continue.
- Playwright/CDP remains for navigation, reconnect, bounded recovery and compatibility fallback.
- Deterministic exact-once dispatch/result relay remains mandatory.
- Text-only Work → Brain relay remains mandatory.
- Owner STOP/AUTOSTART_DISABLED always wins.
- No paid OpenAI API is required in the production path; target incremental OpenAI API cost is **$0**.
- Future MCP support is transport-optional and must not become a runtime dependency.
- Merge/deploy/hotpatch remains **OWNER_EXPLICIT_ONLY**.

## Supporting contracts

These remain relevant supporting contracts and are not superseded by the V3 topology pivot:

- `docs/MAGASIN_LANE_DIRECTIVE_V1_PROTOCOL.md` — Brain → Robot directive serialization and planning/result-verdict contract.
- `docs/PROJECT_ADAPTER_V1.md` — project/platform boundary.
- `docs/STATE_ROOT_V1.md` — state-root compatibility/safety contract.

The core Brain workflow remains:

`PLAN → DISPATCH → VERIFY → ACCEPT/REJECT → NEXT PLAN`

Only one bounded task may be active at a time.

## Production safety

Production/private data, authenticated browser profiles, target conversation identifiers, cookies, tokens, credentials and message bodies remain outside Git.

Supervisor must fail closed on:

- login/credential entry;
- MFA/OTP;
- CAPTCHA;
- destructive or security-sensitive actions;
- ambiguous Owner decisions;
- Owner STOP/AUTOSTART_DISABLED;
- deterministic inaccessible/missing exact targets after bounded recovery.

## Development

Requirements:

- Node.js >= 20
- `playwright-core`

Run tests:

```powershell
npm test
```

The V3 roadmap requires a new locked-candidate qualification sequence before production cutover:

**20-minute smoke → 1-hour continuous soak → 4-hour fault-injection soak → 8-hour unattended soak**.

Old Three-Lane soak evidence remains historical evidence and cannot qualify V3.
