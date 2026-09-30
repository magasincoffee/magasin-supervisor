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
  const liveness = script.indexOf("SC013_LIVE_WAIT_RESPONSE_LIVENESS");
  const progress = script.indexOf("$lastProgress=[DateTimeOffset]::UtcNow", liveness);
  const stall = script.indexOf("SC013 no durable progress for $StallSeconds seconds", progress);

  assert.ok(waitGuard >= 0);
  assert.ok(probe >= 0);
  assert.ok(liveness > waitGuard);
  assert.ok(progress > liveness);
  assert.ok(stall > progress);

  assert.match(helper, /SC013_UI_RESPONSE_RUNNING=/);
  assert.match(helper, /SC013_UI_ASSISTANT_BUSY=/);
  assert.match(helper, /SC013_UI_MAIN_BUSY=/);
  assert.match(helper, /SC013_UI_ASSISTANT_COUNT=/);
  assert.match(helper, /SC013_UI_ASSISTANT_CHARS=/);
});
