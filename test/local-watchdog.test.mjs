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
