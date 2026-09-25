import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  appendSanitizedSupervisorLog,
  sanitizeSupervisorLogEvent
} from "../src/runtime/sanitized-log.mjs";
import {
  serializeLaneEvent,
  LANE_EVENT_TYPES
} from "../src/runtime/lane-events.mjs";

const DISPATCH = "a".repeat(32);
const RELAY = "b".repeat(32);
const DIGEST = "c".repeat(64);

test("P7 supervisor log keeps bounded correlation fields and drops private payloads", () => {
  const safe = sanitizeSupervisorLogEvent({
    type: "LANE_WORK_DISPATCHED",
    laneId: "lane-1",
    taskId: "TASK-P7-01",
    generation: 9,
    workUrlRevision: 4,
    dispatchId: DISPATCH,
    relayId: RELAY,
    digest: DIGEST,
    reasonCode: "AUTO_WORK_DISPATCH_CONFIRMED",
    reason: "attempts=2;mode=AUTO",
    errorName: "TimeoutError",
    cdpPort: 9222,
    nodeExitCode: 75,
    chat_body: "PRIVATE CHAT BODY",
    url: "https://chatgpt.com/c/private",
    token: "sk-proj-private"
  }, {
    runtimeVersion: "2026-09-20.60",
    now: () => new Date("2026-09-25T00:00:00.000Z")
  });

  assert.deepEqual(safe, {
    schema_version: "supervisor-log.v1",
    timestamp: "2026-09-25T00:00:00.000Z",
    type: "LANE_WORK_DISPATCHED",
    runtime_version: "2026-09-20.60",
    lane_id: "lane-1",
    task_id: "TASK-P7-01",
    work_generation: 9,
    work_url_revision: 4,
    dispatch_id: DISPATCH,
    relay_id: RELAY,
    digest: DIGEST,
    reason_code: "AUTO_WORK_DISPATCH_CONFIRMED",
    reason: "attempts=2;mode=AUTO",
    error_name: "TimeoutError",
    node_exit_code: 75,
    cdp_port: 9222
  });

  const text = JSON.stringify(safe);
  assert.doesNotMatch(text, /PRIVATE CHAT BODY|chatgpt\.com|sk-proj|chat_body|token/i);
});

test("P7 supervisor log drops URL/path/raw error and credential-like reason text", () => {
  for (const reason of [
    "https://chatgpt.com/c/private",
    "C:\\Users\\Owner\\private.txt",
    "token=sk-proj-secret",
    "cookie=session-secret",
    "password=hunter2",
    "Bearer=abc"
  ]) {
    const safe = sanitizeSupervisorLogEvent({
      type: "LANE_ERROR",
      laneId: "lane-1",
      taskId: "TASK-P7-02",
      reason,
      errorName: "Error"
    }, { runtimeVersion: "2026-09-20.60" });
    assert.equal(Object.hasOwn(safe, "reason"), false, reason);
  }
});

test("P7 supervisor log is bounded by rotating to a short tail", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-p7-log-"));
  const file = path.join(dir, "supervisor.log");
  try {
    for (let i = 0; i < 30; i += 1) {
      await appendSanitizedSupervisorLog(file, {
        type: "EVENT",
        reason: `turn=${i}`
      }, {
        runtimeVersion: "2026-09-20.60",
        maxBytes: 350,
        tailLines: 3
      });
    }
    const lines = (await fs.readFile(file, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean);
    assert.ok(lines.length <= 5, `unexpected retained lines: ${lines.length}`);
    assert.match(lines.at(-1), /"reason":"turn=29"/);
    assert.doesNotMatch(lines.join("\n"), /"reason":"turn=0"/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("P7 lane events carry runtime version but still reject private raw fields", () => {
  const event = serializeLaneEvent({
    lane_id: "lane-1",
    actor: "SUPERVISOR",
    event_type: LANE_EVENT_TYPES.WORK_DISPATCH_CONFIRMED,
    task_id: "TASK-P7-03",
    phase: "STARTED",
    work_generation: 4,
    work_url_revision: 6,
    dispatch_id: DISPATCH,
    runtime_version: "2026-09-20.60"
  }, {
    now: () => new Date("2026-09-25T00:00:00.000Z")
  });

  assert.equal(event.runtime_version, "2026-09-20.60");
  assert.throws(
    () => serializeLaneEvent({
      lane_id: "lane-1",
      actor: "SUPERVISOR",
      event_type: LANE_EVENT_TYPES.RECOVERY,
      phase: "RECOVERY",
      runtime_version: "https://private/runtime"
    }),
    /runtime_version/
  );
  assert.throws(
    () => serializeLaneEvent({
      lane_id: "lane-1",
      actor: "SUPERVISOR",
      event_type: LANE_EVENT_TYPES.RECOVERY,
      phase: "RECOVERY",
      url: "https://chatgpt.com/c/private"
    }),
    /field is not allowlisted/
  );
});

test("P7 runtime injects runtime version and key dispatch/relay correlations", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /appendSanitizedSupervisorLog/);
  assert.match(
    source,
    /laneEventSink\.emit\(\{[\s\S]*?runtime_version: SUPERVISOR_RUNTIME_VERSION/
  );
  assert.match(
    source,
    /type: rollover[\s\S]*?LANE_WORK_DISPATCHED[\s\S]*?dispatchId[\s\S]*?generation:[\s\S]*?workUrlRevision:/
  );
  assert.match(
    source,
    /type: "LANE_WORK_RESULT_RELAYED"[\s\S]*?relayId:[\s\S]*?generation:[\s\S]*?workUrlRevision:/
  );
  assert.match(
    source,
    /type: "LANE_OWNER_MAINTENANCE_WORK_STATE_RESET"[\s\S]*?generation:[\s\S]*?workUrlRevision:/
  );
});

test("P7 wrapper log is allowlisted, bounded, runtime-versioned and records node exit code", async () => {
  const wrapper = await fs.readFile(
    new URL("../windows/run-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(wrapper, /Get-WrapperRuntimeVersion/);
  assert.match(wrapper, /runtime_version = Get-WrapperRuntimeVersion/);
  assert.match(wrapper, /\$allowed = @\(/);
  assert.match(wrapper, /'cdp_port'/);
  assert.match(wrapper, /'exit_code'/);
  assert.match(wrapper, /\$record\['node_exit_code'\] = \$number/);
  assert.match(wrapper, /Length -gt 2097152/);
  assert.match(wrapper, /Get-Content \$wrapperLogFile -Tail 500/);
  assert.doesNotMatch(wrapper, /\$record\[\$key\] = \$Fields\[\$key\]/);
});
