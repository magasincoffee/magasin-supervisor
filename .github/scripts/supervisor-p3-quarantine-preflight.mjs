import fs from "node:fs";
import path from "node:path";

import {
  normalizeChatGptConversationUrl,
  sha256
} from "../../src/runtime/three-lane.mjs";
import {
  isTargetQuarantined,
  targetHealthIdentity
} from "../../src/runtime/target-health.mjs";

const root = String(process.env.P2_TEMP_STATE_ROOT || "").trim();
if (!root) throw new Error("P3_QUARANTINE_PREFLIGHT_ROOT_MISSING");

const registryPath = path.join(root, "lane-registry.json");
const registry = JSON.parse(
  fs.readFileSync(registryPath, "utf8").replace(/^\uFEFF/, "")
);
const lane = registry?.lanes?.["lane-1"];
if (!lane?.work_url) throw new Error("P3_QUARANTINE_PREFLIGHT_WORK_URL_MISSING");

const normalized = normalizeChatGptConversationUrl(lane.work_url);
const identity = targetHealthIdentity({
  role: "WORK",
  targetDigest: sha256(normalized),
  targetRevision: Number(lane.applied_work_url_revision || 0),
  workGeneration: Number(lane.work_generation || 0)
});

const health = lane.work_target_health || {};
const match = isTargetQuarantined(health, identity);
console.log("LIVE_P3_PREFLIGHT_NORMALIZED_TARGET=True");
console.log("LIVE_P3_PREFLIGHT_HEALTH_STATE=" + String(health.state || "UNKNOWN"));
console.log("LIVE_P3_PREFLIGHT_DIGEST_MATCH=" + String(
  String(health.target_digest || "") === identity.target_digest
));
console.log("LIVE_P3_PREFLIGHT_QUARANTINED=" + String(match));
console.log("LIVE_P3_PREFLIGHT_REVISION=" + Number(lane.applied_work_url_revision || 0));
console.log("LIVE_P3_PREFLIGHT_GENERATION=" + Number(lane.work_generation || 0));

if (!match) throw new Error("P3_QUARANTINE_PREFLIGHT_NOT_QUARANTINED");
