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


## Python Coordinator bridge (source-only, NOT installed)

`sot-preflight-python-bridge.py` is a candidate read-only integration utility matching the existing Python Gateway SQLite schema. It selects up to five canonical SC-013 `WAIT_SOT_AUTHORITY` requests per invocation, reads SQLite using `mode=ro`, checks the exact H4A16IL hostname and STOP/AUTOSTART_DISABLED files, and invokes only the adjacent pinned Node preflight CLI by a fixed argv (no shell). It returns a bounded JSON diagnostic on stdout and **never writes to Gateway, Coordinator or Issue state**. A SOT preflight READY result is still not authorization to execute; it does not inspect or modify the unqualified `owner_enabled.json` placeholder.

Both Node and Python modules must be staged together in the same isolated directory through a **separately reviewed SOT-compliant local staging boundary**. This repository PR must not automatically copy them to `D:\MAGASIN_ROBOTS\robots\coordinator`, edit `coordinator.py`, alter Windows tasks, clear STOP or enable any specialist. A future reviewed integration must prove trusted Gateway author/receipt continuity and attach live Owner lifecycle authority, not infer enablement from GitHub/SQLite text.

Hosted regression: `python -m unittest discover -s test -p 'test_sc013_sot_python_bridge.py' -v`. This is source-only test evidence, not successful live-machine integration.
