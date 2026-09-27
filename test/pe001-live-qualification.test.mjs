import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("PE-001 live qualification is isolated to two normal chats and privacy-safe evidence", async () => {
  const source = await fs.readFile(
    new URL("../.github/scripts/supervisor-pe001-live-qualification.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /normal ChatGPT/i);
  assert.match(source, /plannerPage = await adapter\.newChatPage/);
  assert.match(source, /executorPage = await adapter\.newChatPage/);
  assert.match(source, /PE001_LIVE_CHATGPT_WORK_MODE_INVOCATIONS/);
  assert.match(source, /cycleSendCount !== 3/);
  assert.match(source, /user_turn_evidence/);
  assert.match(source, /production_state_mutated: false/);
  assert.match(source, /production_targets_mutated: false/);
  assert.match(source, /preexistingPages > 2/);
  assert.doesNotMatch(source, /lane-registry\.json/);
  assert.doesNotMatch(source, /lanes\.json/);
  assert.doesNotMatch(source, /brain_url/);
  assert.doesNotMatch(source, /work_url/);
  assert.doesNotMatch(source, /ChatGPT Work mode[^\n]*true/i);
});

test("PE-001 live workflow is target-guarded and does not deploy production", async () => {
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

  assert.match(wrapper, /PE001_QUAL_TARGET_MATCH=False/);
  assert.match(wrapper, /127\.0\.0\.1:9222\/json\/version/);
  assert.match(wrapper, /supervisor-pe001-live-qualification\.mjs/);
});
