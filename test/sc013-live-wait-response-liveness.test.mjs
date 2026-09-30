import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("SC-013 live harness uses UI liveness before WAIT_RESPONSE stall failure", async () => {
  const script = await fs.readFile(
    new URL("../.github/scripts/supervisor-sc013-live-production.ps1", import.meta.url),
    "utf8"
  );
  const helper = await fs.readFile(
    new URL("../.github/scripts/sc013-wait-response-liveness.mjs", import.meta.url),
    "utf8"
  );

  const waitGuard = script.indexOf("$waitingForResponse");
  const probe = script.indexOf("sc013-wait-response-liveness.mjs");
  const active = script.indexOf("$uiActive=[bool]", waitGuard);
  const progress = script.indexOf("$lastProgress=[DateTimeOffset]::UtcNow", active);
  const liveness = script.indexOf("SC013_LIVE_WAIT_RESPONSE_LIVENESS", progress);
  const stall = script.indexOf("SC013 no durable progress for $StallSeconds seconds", liveness);

  assert.ok(waitGuard >= 0);
  assert.ok(probe >= 0);
  assert.ok(active > waitGuard);
  assert.ok(progress > active);
  assert.ok(liveness > progress);
  assert.ok(stall > liveness);

  assert.match(helper, /SC013_UI_RESPONSE_RUNNING=/);
  assert.match(helper, /SC013_UI_ASSISTANT_BUSY=/);
  assert.match(helper, /SC013_UI_MAIN_BUSY=/);
  assert.match(helper, /SC013_UI_ASSISTANT_COUNT=/);
  assert.match(helper, /SC013_UI_ASSISTANT_CHARS=/);
});


test("SC-013 WAIT_RESPONSE is exempt from generic stall timeout", async () => {
  const script = await fs.readFile(
    new URL("../.github/scripts/supervisor-sc013-live-production.ps1", import.meta.url),
    "utf8"
  );

  const waitGuard = script.indexOf("$waitingForResponse=[bool]");
  const stallCondition = script.indexOf("-not $waitingForResponse -and", waitGuard);
  const stallThrow = script.indexOf("SC013 no durable progress for $StallSeconds seconds", stallCondition);

  assert.ok(waitGuard >= 0);
  assert.ok(stallCondition > waitGuard);
  assert.ok(stallThrow > stallCondition);
});
