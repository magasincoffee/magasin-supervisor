# SC-013 Coordinator SOT Adapter (source-only)

This directory is a **non-executing** proof stage for the Owner-approved Robot Tổng program in the canonical root `SOURCE_OF_TRUTH.md`.

- `sot-adapter.mjs`: strictly allowlisted GitHub/Supervisor/SC-013 SOT inspection, pinned main SHA + second head check, reject missing/ambiguous task authority. `verifySot` also requires trusted local lifecycle guards. Neither function dispatches anything.
- `sot-preflight-cli.mjs`: narrow stdin JSON -> stdout JSON transport intended for a **future separately approved Python Coordinator bridge**. It performs GitHub GET only. No SQLite changes, no browser/ChatGPT outbound, no file writes, no robot START/STOP.

Example request (supply on stdin from an independently validated Gateway envelope; this example is not an executable instruction):

```json
{"schema":"MAGASIN_DISPATCH_V1","task_id":"SC-013","target":"supervisor","action":"execute_task","sot_url":"https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md"}
```

The CLI only outputs `SOT_PREFLIGHT_BLOCKED`, `SOT_PREFLIGHT_READY_NOT_AUTHORIZED`, `SOT_PREFLIGHT_UNAVAILABLE` or `REJECTED`, **always** with `execution_qualified=false` and `dispatched=false`. `READY_NOT_AUTHORIZED` is *not* permission to run a task. It does not read or infer Owner-enable state; the future integrator must independently verify valid Gateway receipt/author, live Owner lifecycle authority/STOP, target machine, worker acknowledgement and current SOT revision before any downstream action.

The current real canonical `SC-013` is `IN PROGRESS`, not `READY`, and cannot become executable because the CLI succeeds. Other robots and task IDs are not allowlisted. The legacy `D:\MAGASIN_ROBOTS\robots\coordinator\coordinator.py` Python runtime is **not** automatically wired to this repository source. No local deployment/installer is contained here; H4A16IL staging/apply is governed separately by SOT and explicit Owner gates.

Hosted regression: `node --test test/sc013-sot-adapter.test.mjs`. CI checks run on PRs; passing hosted tests is not real production execution acceptance.
