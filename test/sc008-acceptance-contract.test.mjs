import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("SC-008 live qualification bounds CDP cleanup and exits explicitly", async () => {
  const source = await fs.readFile(
    new URL("../.github/scripts/supervisor-sc008-live-qualification.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /boundedCleanup/);
  assert.match(source, /SC008_LIVE_CLEANUP_TIMEOUT_/);
  assert.match(source, /process\.exit\(finalExitCode\)/);
  assert.doesNotMatch(
    source,
    /SC008_LIVE_ERROR_NAME[\s\S]{0,160}throw error/
  );
});

test("SC-008 live harness covers the canonical ten-item acceptance matrix", async () => {
  const source = await fs.readFile(
    new URL("../.github/scripts/supervisor-sc008-live-qualification.mjs", import.meta.url),
    "utf8"
  );
  for (let index = 1; index <= 10; index += 1) {
    assert.match(source, new RegExp("SC008_MATRIX_" + index + "_"));
  }
  assert.match(source, /createNewChatAndBootstrap/);
  assert.match(source, /runSingleConversationCycles/);
  assert.match(source, /replaceDisposableConversation/);
  assert.match(source, /reconcileExactOnceOutbound/);
  assert.match(source, /getChatGptPageCount\(\) !== 1/);
  assert.match(source, /planner_url\|executor_url/);
});

test("SC-008 cold browser launch stays inert until Robot navigation", async () => {
  const source = await fs.readFile(
    new URL("../.github/scripts/supervisor-sc008-live-qualification.ps1", import.meta.url),
    "utf8"
  );

  const start = source.indexOf("Start-Process -FilePath $chromeExecutable");
  const end = source.indexOf("for ($i = 0; $i -lt 40; $i++)", start);
  const launch = source.slice(start, end);
  assert.match(launch, /'about:blank'/);
  assert.doesNotMatch(launch, /'https:\/\/chatgpt\.com\/'/);
});

test("SC-008 Windows wrapper performs a true dedicated-Chrome cold restart", async () => {
  const source = await fs.readFile(
    new URL("../.github/scripts/supervisor-sc008-live-qualification.ps1", import.meta.url),
    "utf8"
  );
  assert.match(source, /Restart-QualificationDedicatedChrome/);
  assert.match(source, /SC008_QUAL_COLD_CHROME_RESTART=True/);
  assert.match(source, /browser_profile/);
  assert.match(source, /SC008_QUAL_PRODUCTION_PROJECT_STATE_MUTATED=False/);
});

test("SC-008 workflow requires a target-machine authority PASS", async () => {
  const source = await fs.readFile(
    new URL("../.github/workflows/supervisor-sc008-cold-start-qualification.yml", import.meta.url),
    "utf8"
  );
  assert.match(source, /DESKTOP-4K7IM13/);
  assert.match(source, /qualification-authority/);
  assert.match(source, /SC008_QUALIFICATION_AUTHORITY=PASS/);
  assert.match(source, /ExecutionPolicy Bypass/);
});
