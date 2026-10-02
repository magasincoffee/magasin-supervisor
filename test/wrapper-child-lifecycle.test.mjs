import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(rel) {
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

test("lifecycle process truth accepts only direct single-conversation child", async () => {
  const lifecycle = await read("../windows/lifecycle-truth.ps1");

  assert.match(lifecycle, /function Get-LifecycleSingleConversationProcess/);
  assert.match(lifecycle, /Get-LifecycleSupervisorWrapper -Root \$Root/);
  assert.match(lifecycle, /\[int\]\$_\.ParentProcessId -eq \$wrapperPid/);
  assert.match(lifecycle, /single_conversation_alive/);
  assert.doesNotMatch(lifecycle, /ThreeLane|PlannerExecutor/);
});

test("wrapper reclaims only orphan single-conversation nodes", async () => {
  const wrapper = await read("../windows/run-supervisor.ps1");

  assert.match(wrapper, /function Stop-OrphanSingleNodes/);
  assert.match(wrapper, /single-conversation-cli\.mjs/);
  assert.match(wrapper, /ORPHAN_SINGLE_CONVERSATION_STOPPED/);
  assert.match(wrapper, /function Stop-CurrentChild/);
  assert.doesNotMatch(wrapper, /three-lane|planner-executor|brain-worker|supervisor-loop/i);
});

test("wrapper has one fixed runtime entry point and fail-closed BLOCKED pause", async () => {
  const wrapper = await read("../windows/run-supervisor.ps1");

  const launches = [...wrapper.matchAll(/single-conversation-cli\.mjs/g)];
  assert.ok(launches.length >= 1);
  assert.match(wrapper, /SINGLE_CONVERSATION_BLOCKED_PAUSE=True/);
  assert.match(wrapper, /\$exitCode -eq 75/);
  assert.match(wrapper, /\$exitCode -eq 76/);
  assert.doesNotMatch(wrapper, /switch \(\$runtimeMode\)/);
});
