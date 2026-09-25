import fs from "node:fs/promises";
import path from "node:path";

import {
  appendSanitizedSupervisorLog
} from "../../src/runtime/sanitized-log.mjs";
import {
  appendLaneEvent,
  LANE_EVENT_TYPES
} from "../../src/runtime/lane-events.mjs";

const root = String(process.env.P7_TEMP_ROOT || "").trim();
if (!root) throw new Error("P7_TEMP_ROOT_REQUIRED");

const supervisorLog = path.join(root, "supervisor.log");
const laneEvents = path.join(root, "lane-events.ndjson");
const runtimeVersion = "P7-LIVE-1";
const dispatchId = "a".repeat(32);
const relayId = "b".repeat(32);
const digest = "c".repeat(64);

await fs.mkdir(root, { recursive: true });

// Force one bounded rotation using many ordinary lines rather than an
// impossible giant record. After the next append the old sentinel must vanish.
const filler = [
  JSON.stringify({ old: "P7_OLD_SENTINEL", n: -1, pad: "x".repeat(850) }),
  ...Array.from(
    { length: 2600 },
    (_, i) => JSON.stringify({
      old: "P7_OLD_FILLER",
      n: i,
      pad: "x".repeat(850)
    })
  )
].join("\n") + "\n";
await fs.writeFile(supervisorLog, filler, "utf8");

const safe = await appendSanitizedSupervisorLog(
  supervisorLog,
  {
    type: "LANE_WORK_DISPATCHED",
    laneId: "lane-1",
    taskId: "P7-LIVE-TASK",
    generation: 12,
    workUrlRevision: 6,
    dispatchId,
    relayId,
    digest,
    reasonCode: "AUTO_WORK_DISPATCH_CONFIRMED",
    reason: "attempts=1;mode=AUTO",
    errorName: "TimeoutError",
    nodeExitCode: 75,
    cdpPort: 9222,

    // Deliberately hostile/private inputs: none may survive serialization.
    chat_body: "P7_PRIVATE_CHAT_BODY",
    url: "https://chatgpt.com/c/p7-private-conversation",
    token: "sk-proj-p7-private-token",
    screenshot: "C:\\private\\p7.png",
    raw_error: "Authorization: Bearer p7-private"
  },
  { runtimeVersion }
);

await appendSanitizedSupervisorLog(
  supervisorLog,
  {
    type: "LANE_ERROR",
    laneId: "lane-1",
    taskId: "P7-LIVE-TASK",
    reason: "token=sk-proj-p7-private-token",
    errorName: "Error"
  },
  { runtimeVersion }
);

const laneEvent = await appendLaneEvent(laneEvents, {
  lane_id: "lane-1",
  actor: "SUPERVISOR",
  event_type: LANE_EVENT_TYPES.WORK_DISPATCH_CONFIRMED,
  task_id: "P7-LIVE-TASK",
  phase: "STARTED",
  reason_code: "AUTO_WORK_DISPATCH_CONFIRMED",
  work_generation: 12,
  work_url_revision: 6,
  dispatch_id: dispatchId,
  relay_id: relayId,
  runtime_version: runtimeVersion
});

const supervisorText = await fs.readFile(supervisorLog, "utf8");
const laneText = await fs.readFile(laneEvents, "utf8");

for (const forbidden of [
  "P7_PRIVATE_CHAT_BODY",
  "chatgpt.com/c/p7-private-conversation",
  "sk-proj-p7-private-token",
  "C:\\private\\p7.png",
  "Authorization",
  "P7_OLD_SENTINEL"
]) {
  if (supervisorText.includes(forbidden) || laneText.includes(forbidden)) {
    throw new Error("P7_PRIVATE_DIAGNOSTIC_LEAK:" + forbidden);
  }
}

for (const [name, actual, expected] of [
  ["runtime_version", safe.runtime_version, runtimeVersion],
  ["lane_id", safe.lane_id, "lane-1"],
  ["task_id", safe.task_id, "P7-LIVE-TASK"],
  ["work_generation", safe.work_generation, 12],
  ["work_url_revision", safe.work_url_revision, 6],
  ["dispatch_id", safe.dispatch_id, dispatchId],
  ["relay_id", safe.relay_id, relayId],
  ["reason_code", safe.reason_code, "AUTO_WORK_DISPATCH_CONFIRMED"],
  ["node_exit_code", safe.node_exit_code, 75],
  ["cdp_port", safe.cdp_port, 9222],
  ["lane_runtime_version", laneEvent.runtime_version, runtimeVersion]
]) {
  if (actual !== expected) {
    throw new Error(`P7_CORRELATION_MISMATCH_${name}`);
  }
}

const stat = await fs.stat(supervisorLog);
if (stat.size > 2 * 1024 * 1024) {
  throw new Error("P7_SUPERVISOR_LOG_NOT_BOUNDED");
}

console.log("LIVE_P7_SUPERVISOR_LOG_SANITIZED=PASS");
console.log("LIVE_P7_SUPERVISOR_LOG_BOUNDED=PASS");
console.log("LIVE_P7_LANE_EVENTS_SANITIZED=PASS");
console.log("LIVE_P7_RUNTIME_VERSION_CORRELATED=PASS");
console.log("LIVE_P7_TASK_CORRELATED=PASS");
console.log("LIVE_P7_GENERATION_CORRELATED=PASS");
console.log("LIVE_P7_WORK_REVISION_CORRELATED=PASS");
console.log("LIVE_P7_DISPATCH_RELAY_CORRELATED=PASS");
console.log("LIVE_P7_REASON_CODE_CORRELATED=PASS");
console.log("LIVE_P7_NODE_EXIT_CDP_CORRELATED=PASS");
