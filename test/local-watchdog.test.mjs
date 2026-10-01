import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const read = (path) =>
  fs.readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("SC-013 local watchdog is continuous, singleton, bounded, and read-only", async () => {
  const source = await read("windows/local-watchdog.ps1");

  assert.match(source, /while \(\$true\)/);
  assert.match(source, /MAGASIN_SUPERVISOR_LOCAL_WATCHDOG/);
  assert.match(source, /local-watchdog-status\.json/);
  assert.match(source, /local-watchdog-events\.ndjson/);
  assert.match(source, /local-watchdog-failures/);
  assert.match(source, /PollSeconds = 5/);
  assert.match(source, /UiProbeSeconds = 30/);
  assert.match(source, /PREPARED_STALLED/);
  assert.match(source, /ENQUEUED_STALLED/);
  assert.match(source, /CHATGPT_NETWORK_ERROR/);
  assert.match(source, /CHATGPT_RUNTIME_IDENTITY_MISMATCH/);
  assert.match(source, /ownerStop\.blocked/);
  assert.doesNotMatch(source, /sendComposerInstruction/);
  assert.doesNotMatch(source, /reconcileExactOnceOutbound/);
  assert.doesNotMatch(source, /start-supervisor\.ps1/);
});

test("SC-013 local ChatGPT probe never navigates or sends and persists no conversation URL", async () => {
  const source = await read("src/runtime/local-watchdog-probe-cli.mjs");

  assert.match(source, /getChatGptPages\(\)/);
  assert.match(source, /opaqueRuntimeIdentity/);
  assert.match(source, /probePage\(page\)/);
  assert.match(source, /inspectComposerDraftDigest/);
  assert.match(source, /exact_runtime_match/);
  assert.match(source, /draft_digest/);
  assert.doesNotMatch(source, /reopenTargetPage/);
  assert.doesNotMatch(source, /resumeExistingConversationPage/);
  assert.doesNotMatch(source, /sendComposerInstruction/);
  assert.doesNotMatch(source, /normalized_text\s*:/);
  assert.doesNotMatch(source, /url\s*:/);
});

test("SC-013 local watchdog launcher survives GitHub runner cleanup and verifies heartbeat", async () => {
  const source = await read("windows/start-local-watchdog.ps1");

  assert.match(source, /MAGASIN_LOCAL_WATCHDOG_PERSISTENT/);
  assert.match(source, /local-watchdog\.ps1/);
  assert.match(source, /WaitForHeartbeat/);
  assert.match(source, /LOCAL_WATCHDOG_HEARTBEAT_FRESH=True/);
});

test("SC-013 GitHub watchdog requires a fresh local watchdog heartbeat", async () => {
  const source = await read(".github/scripts/sc013-runtime-watchdog.ps1");

  assert.match(source, /local-watchdog-status\.json/);
  assert.match(source, /LOCAL_WATCHDOG_STATUS_MISSING/);
  assert.match(source, /LOCAL_WATCHDOG_STALE/);
  assert.match(source, /SC013_WATCHDOG_LOCAL_MODE/);
  assert.match(source, /LOCAL:\$\(\[string\]\$localFault\)/);
});


test("SC-013 watchdog launcher never mistakes its own start script for the observer", async () => {
  const [launcher, installer, updater] = await Promise.all([
    read("windows/start-local-watchdog.ps1"),
    read("windows/install-supervisor.ps1"),
    read(".github/scripts/update-latest-clean-old.ps1")
  ]);
  for (const source of [launcher, installer, updater]) {
    assert.match(source, /-notlike '\*start-local-watchdog\.ps1\*'/);
  }
});


test("SC-013 watchdog signature construction is Windows PowerShell 5.1 parse-safe", async () => {
  const source = await read("windows/local-watchdog.ps1");
  assert.match(source, /\$signatureAutomation = if \(\$stateReadable\)/);
  assert.match(source, /\$signaturePhase = if \(\$stateReadable\)/);
  assert.match(source, /\$signatureOutbound = if \(\$stateReadable\)/);
  assert.match(source, /\$signatureError = if \(\$stateReadable\)/);
  assert.doesNotMatch(source, /\[string\]::Join\('~', @\([\s\S]*?,\s*if \(\$stateReadable\)/);
});


test("SC-013 local UI probe cannot block the 24/7 watchdog heartbeat", async () => {
  const source = await read("windows/local-watchdog.ps1");
  assert.match(source, /WaitForExit\(20000\)/);
  assert.match(source, /UI_PROBE_TIMEOUT/);
  assert.match(source, /RedirectStandardOutput/);
  assert.match(source, /Stop-Process -Id \$process\.Id -Force/);
  assert.match(source, /\$lastUiProbeAt = \[DateTimeOffset\]::UtcNow/);
  assert.doesNotMatch(source, /\$raw = & node\.exe \$probeCli/);
});


test("SC-013 local UI probe error results keep a complete StrictMode-safe shape", async () => {
  const source = await read("windows/local-watchdog.ps1");
  assert.match(source, /function New-UiProbeErrorResult/);
  for (const field of [
    "expected_runtime_id_present",
    "exact_runtime_match",
    "login_required",
    "has_captcha",
    "has_network_error",
    "has_transient_error",
    "has_retry_control",
    "conversation_full",
    "conversation_missing",
    "conversation_access_denied",
    "probe_error"
  ]) {
    assert.match(source, new RegExp(field));
  }
  assert.match(source, /WaitForExit\(20000\)/);
  assert.match(source, /New-UiProbeErrorResult -Code 'UI_PROBE_TIMEOUT'/);
  assert.match(source, /New-UiProbeErrorResult -Code 'UI_PROBE_FAILED'/);
  assert.match(source, /New-UiProbeErrorResult -Code 'UI_PROBE_EMPTY'/);
  assert.match(source, /New-UiProbeErrorResult -Code 'UI_PROBE_EXCEPTION'/);
  assert.doesNotMatch(source, /WaitForExit\(8000\)/);
});


test("SC-013 disposable CDP probe flushes one result then exits without closing production Chrome", async () => {
  const source = await read("src/runtime/local-watchdog-probe-cli.mjs");
  assert.match(source, /process\.stdout\.write\(JSON\.stringify\(result\), \(\) => process\.exit\(0\)\)/);
  assert.doesNotMatch(source, /browser\.close\(/);
  assert.doesNotMatch(source, /context\.close\(/);
});


test("SC-013 local UI probe contains state read inside structured result handling", async () => {
  const source = await read("src/runtime/local-watchdog-probe-cli.mjs");
  const resultIndex = source.indexOf("const result =");
  const tryIndex = source.indexOf("try {", resultIndex);
  const readIndex = source.indexOf("await readSingleConversationState(statePath)", resultIndex);

  assert.ok(resultIndex >= 0);
  assert.ok(tryIndex > resultIndex);
  assert.ok(readIndex > tryIndex);
  assert.doesNotMatch(source.slice(0, tryIndex), /await readSingleConversationState\(statePath\)/);
  assert.match(source, /let adapter = null/);
  assert.match(source, /if \(adapter\)/);
  assert.match(source, /process\.stdout\.write\(JSON\.stringify\(result\), \(\) => process\.exit\(0\)\)/);
});


test("SC-013 rebind diagnostic captures direct local probe exit evidence", async () => {
  const source = await read(".github/scripts/supervisor-sc013-rebind-diagnostic.ps1");
  assert.match(source, /local-watchdog-probe-cli\.mjs/);
  assert.match(source, /SC013_DIAG_DIRECT_PROBE_EXIT=/);
  assert.match(source, /SC013_DIAG_DIRECT_PROBE_STDOUT=/);
  assert.match(source, /SC013_DIAG_DIRECT_PROBE_STDERR=/);
  assert.match(source, /WaitForExit\(25000\)/);
  assert.match(source, /Remove-Item \$probeOut,\$probeErr -Force/);
});
