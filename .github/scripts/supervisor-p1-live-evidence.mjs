import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtime = process.env.PROBE_RUNTIME_DIR;
const configFile = process.env.PROBE_CONFIG_FILE;
const registryFile = process.env.PROBE_REGISTRY_FILE;
const cdpUrl = process.env.PROBE_CDP_URL;
const sourceRoot = process.env.GITHUB_WORKSPACE;

if (!runtime || !configFile || !registryFile || !cdpUrl || !sourceRoot) {
  throw new Error("P1 live evidence environment is incomplete");
}

const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
const lane = config.lanes.find((item) => item.lane_id === "lane-1") || {};
const registryLane = registry?.lanes?.["lane-1"] || {};

const three = await import(
  pathToFileURL(path.join(sourceRoot, "src", "runtime", "three-lane.mjs")).href
);
const capture = await import(
  pathToFileURL(path.join(sourceRoot, "src", "ui", "message-capture.mjs")).href
);
const adapterMod = await import(
  pathToFileURL(path.join(runtime, "src", "ui", "playwright-adapter.mjs")).href
);

const exactBrain = three.normalizeChatGptConversationUrl(lane.brain_url);
if (!exactBrain) throw new Error("lane-1 exact Brain target is missing");

const adapter = new adapterMod.ChatGptUiAdapter({ cdpUrl, settleMs: 250 });
await adapter.open();

try {
  let brainPage = null;
  for (const page of adapter.getChatGptPages()) {
    try {
      if (three.normalizeChatGptConversationUrl(page.url()) === exactBrain) {
        brainPage = page;
        break;
      }
    } catch {}
  }
  if (!brainPage) throw new Error("exact configured Brain page is not open");

  const turns = await capture.captureRecentConversationTurns(brainPage, { limit: 30 });
  let directive = null;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role !== "assistant") continue;
    try {
      directive = three.parseLaneDirective(turns[index].text);
      break;
    } catch {}
  }
  if (!directive) throw new Error("no valid completed Brain directive found");
  if (directive.action !== "WORK" || directive.task_id !== "SCHED-06") {
    throw new Error("live Brain directive is not authorized SCHED-06 WORK");
  }

  const targetDigest = three.sha256(exactBrain);
  const appliedRevision = Number(registryLane.applied_brain_url_revision || 0);
  const expectedHandshakeDigest = three.sha256(
    three.buildBrainStartRequest({
      laneId: "lane-1",
      projectName: String(lane.project_name || "Dự án 1")
    })
  );
  const legacyHandshakeDigest = three.sha256(
    three.buildLegacyBrainStartRequestV59({
      laneId: "lane-1",
      projectName: String(lane.project_name || "Dự án 1")
    })
  );

  const policy = three.evaluateBrainDirectiveAdoptionEvidence({
    turns,
    expectedHandshakeDigests: [expectedHandshakeDigest, legacyHandshakeDigest],
    currentTargetDigest: targetDigest,
    configuredTargetDigest: targetDigest,
    configuredRevision: Number(lane.brain_url_revision || 0),
    appliedRevision,
    brainRequestInflight: {
      digest: expectedHandshakeDigest,
      brain_target_digest: targetDigest,
      brain_url_revision: appliedRevision
    },
    adoptedRecord: null,
    activeExactOnce: false
  });

  if (!policy.adopt || policy.directive?.digest !== directive.digest) {
    throw new Error("P1 live continuity policy did not adopt SCHED-06");
  }

  const durableTaskMatch = String(registryLane.task_id || "") === directive.task_id;
  const durableDirectiveMatch =
    String(registryLane.last_brain_directive_digest || "") === directive.digest;
  const durableInstructionMatch =
    String(registryLane.instruction_digest || "") === directive.instruction_digest;

  if (!durableTaskMatch || !durableDirectiveMatch || !durableInstructionMatch) {
    throw new Error("durable registry identity does not match live SCHED-06 directive");
  }

  console.log("LIVE_P1_EXACT_BRAIN_OPEN=True");
  console.log("LIVE_P1_DIRECTIVE_ACTION=" + directive.action);
  console.log("LIVE_P1_DIRECTIVE_TASK_ID=" + directive.task_id);
  console.log("LIVE_P1_DIRECTIVE_DIGEST=" + directive.digest);
  console.log("LIVE_P1_POLICY_ADOPT=True");
  console.log("LIVE_P1_POLICY_REASON=" + policy.reason_code);
  console.log(
    "LIVE_P1_LATER_ROBOT_HANDSHAKES=" +
      Number(policy.later_robot_handshake_count || 0)
  );
  console.log("LIVE_P1_DURABLE_TASK_MATCH=True");
  console.log("LIVE_P1_DURABLE_DIRECTIVE_MATCH=True");
  console.log("LIVE_P1_DURABLE_INSTRUCTION_MATCH=True");
  console.log(
    "LIVE_P1_BRAIN_REQUEST_SENT=" + Boolean(registryLane.brain_request_sent)
  );
  console.log(
    "LIVE_P1_AWAITING_WORK=" + Boolean(registryLane.awaiting_work)
  );
  console.log(
    "LIVE_P1_ADOPTED_RECORD_PRESENT=" +
      Boolean(registryLane.brain_directive_adopted?.directive_digest)
  );
} finally {
  await adapter.close().catch(() => {});
}
