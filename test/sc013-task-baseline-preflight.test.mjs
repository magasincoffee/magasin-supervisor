import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("SC-013 task send requires verified baselines before durable PREPARED", async () => {
  const cli = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const start = cli.indexOf("async function sendProtocolMessage(");
  assert.ok(start >= 0, "sendProtocolMessage exists");
  const prepared = cli.indexOf("await prepareExactOnceOutbound(statePath, {", start);
  assert.ok(prepared > start, "PREPARED is persisted inside task-send lifecycle");
  const preflight = cli.slice(start, prepared);

  assert.match(
    preflight,
    /\["TASK_EXECUTION", "TASK_STATUS_CHECK"\]\.includes\(kind\)/,
    "both replay-sensitive task kinds require a baseline"
  );
  assert.match(
    preflight,
    /!baselineUser\?\.turn_id\s*\|\|\s*!baselineAssistant\?\.turn_id/,
    "both independently observed prior turns must be captured"
  );
  assert.match(
    preflight,
    /code: "TASK_BASELINE_UNVERIFIED"/,
    "missing baseline must produce an explicit fail-closed error"
  );
  assert.doesNotMatch(
    preflight,
    /sendComposerInstruction\(/,
    "no browser submit is permitted before the baseline preflight"
  );
});
