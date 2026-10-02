import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("SC-013 production wrapper has exactly one runtime authority", async () => {
  const source = await fs.readFile(
    new URL("../windows/run-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /src\/runtime\/single-conversation-cli\.mjs/);
  assert.match(source, /SINGLE_CONVERSATION_BLOCKED_PAUSE=True/);

  for (const forbidden of [
    /THREE_LANE_V1/,
    /PLANNER_EXECUTOR_V1/,
    /BRAIN_WORKER_V1/,
    /three-lane-cli/,
    /planner-executor/,
    /brain-worker/,
    /supervisor-loop-cli/
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("SC-013 lifecycle runtime mode cannot fall back to legacy state", async () => {
  const source = await fs.readFile(
    new URL("../windows/lifecycle-truth.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /Get-LifecycleSingleConversationControl/);
  assert.match(source, /return 'SINGLE_CONVERSATION_V1'/);
  assert.doesNotMatch(source, /lanes\.json|planner-executor|THREE_LANE_V1/);
});
