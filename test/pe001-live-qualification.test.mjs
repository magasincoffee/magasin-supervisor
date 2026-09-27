import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("PE-001 live qualification is isolated to normal chats and privacy-safe evidence", async () => {
  const source = await fs.readFile(
    new URL("../.github/scripts/supervisor-pe001-live-qualification.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /normal ChatGPT/i);
  assert.match(source, /plannerPage/);
  assert.match(source, /executorPage = await adapter\.newChatPage/);
  assert.match(source, /PE001_LIVE_CHATGPT_WORK_MODE_INVOCATIONS/);
  assert.match(source, /cycleSendCount !== 3/);
  assert.match(source, /user_turn_evidence/);
  assert.match(source, /production_state_mutated: false/);
  assert.match(source, /production_targets_mutated: false/);
  assert.match(source, /state_root_binding_mutated: false/);
  assert.match(source, /dynamic_cdp: true/);
  assert.match(source, /SUPERVISOR_PE001_CDP_URL/);
  assert.match(source, /adapter\.getChatGptPageCount\(\) !== 2/);
  assert.doesNotMatch(source, /lane-registry\.json/);
  assert.doesNotMatch(source, /lanes\.json/);
  assert.doesNotMatch(source, /brain_url/);
  assert.doesNotMatch(source, /work_url/);
  assert.doesNotMatch(source, /ChatGPT Work mode[^\n]*true/i);
  assert.doesNotMatch(source, /127\.0\.0\.1:9222/);
});

test("PE-001 live workflow dynamically resolves CDP without mutating root binding or runtime lifecycle", async () => {
  const workflow = await fs.readFile(
    new URL("../.github/workflows/supervisor-pe001-live-qualification.yml", import.meta.url),
    "utf8"
  );
  const wrapper = await fs.readFile(
    new URL("../.github/scripts/supervisor-pe001-live-qualification.ps1", import.meta.url),
    "utf8"
  );

  assert.match(workflow, /runs-on: self-hosted/);
  assert.match(workflow, /DESKTOP-4K7IM13/);
  assert.match(workflow, /supervisor-pe001-live-qualification\.ps1/);
  assert.match(workflow, /npm install --ignore-scripts --no-audit --no-fund/);
  assert.doesNotMatch(workflow, /start-supervisor\.ps1/);
  assert.doesNotMatch(workflow, /repair-supervisor\.ps1/);
  assert.doesNotMatch(workflow, /stop-supervisor\.ps1/);

  assert.match(wrapper, /Get-LifecycleRobotChrome/);
  assert.match(wrapper, /remote-debugging-port=/);
  assert.match(wrapper, /9222\.\.9232/);
  assert.match(wrapper, /SUPERVISOR_PE001_CDP_URL/);
  assert.match(wrapper, /PE001_QUAL_STATE_ROOT_BINDING_MUTATED=False/);
  assert.match(wrapper, /supervisor-pe001-live-qualification\.mjs/);
  assert.doesNotMatch(wrapper, /Set-SupervisorStateRootBinding/);
  assert.doesNotMatch(wrapper, /start-supervisor\.ps1/);
  assert.doesNotMatch(wrapper, /repair-supervisor\.ps1/);
  assert.doesNotMatch(wrapper, /stop-supervisor\.ps1/);
  assert.doesNotMatch(wrapper, /127\.0\.0\.1:9222\/json\/version/);
});
