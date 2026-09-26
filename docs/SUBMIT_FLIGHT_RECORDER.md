# Submit Flight Recorder

The Supervisor records each live ChatGPT composer submission as a bounded flight-recorder run.

## Default behavior

`MAGASIN_SUBMIT_DEBUG` defaults to `failures`.

- Every live submit starts a Playwright trace and captures bounded DOM/control snapshots plus viewport screenshots.
- Successful runs are deleted immediately.
- Failed or uncertain submits are preserved under:
  `<SUPERVISOR_STATE_ROOT>/diagnostics/submit/<run-id>/`
- `diagnostics/submit/latest.json` points at the latest preserved incident.
- `diagnostics/submit/incidents.ndjson` is an append-only incident index.

Set `MAGASIN_SUBMIT_DEBUG=all` to keep successful runs too. Set it to `off` to disable recording. `MAGASIN_SUBMIT_DEBUG_DIR` may override only the recorder output directory.

## Evidence captured

A preserved incident contains numbered stage JSON files and screenshots, `meta.json`, `summary.json`, and `trace.zip` when Playwright tracing is available. The stage snapshots include:

- URL/title/focus state and active element.
- Composer readiness, rectangle, text length, and SHA-256 digest.
- Visible buttons around the composer with `aria-label`, `data-testid`, disabled state, and bounding boxes.
- The selected submit target and `document.elementFromPoint()` at its center, which exposes overlays/interception.
- Submit method/selector/scope and the final composer/user-turn verification evidence.

Raw instruction text is intentionally not written to JSON logs. Screenshots and Playwright traces can contain visible conversation content and should be treated as local diagnostic evidence.

## Send success contract

A UI action is not reported as successfully sent merely because `click()` returned. The transaction requires:

1. the exact instruction to be present in the live composer;
2. an actionability-checked Send click, with bounded DOM/force and Enter recovery where applicable;
3. a composer submission transition; and
4. a newly observed user turn whose normalized text matches the instruction.

If the composer changes but the matching user turn is not observed, the result remains `SEND_NOT_ACTUATED` so durable dispatch latches are not advanced.

Run `windows/collect-supervisor-diagnostics.ps1` to print the latest submit-recorder incident alongside the standard Supervisor diagnostics.
