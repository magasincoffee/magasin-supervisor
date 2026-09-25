import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { defaultLaneConfig, defaultLaneRegistry } from "./three-lane.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--root") {
      out.root = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

async function atomicJsonWrite(filePath, value) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.reset-${crypto.randomUUID()}.tmp`
  );
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tmp, filePath);
}

const args = parseArgs(process.argv.slice(2));
if (!args.root || !String(args.root).trim()) {
  throw new Error("--root is required");
}

const root = path.resolve(String(args.root));
const configPath = path.join(root, "lanes.json");
const registryPath = path.join(root, "lane-registry.json");
const statusPath = path.join(root, "lane-status.json");
const eventPath = path.join(root, "lane-events.ndjson");
const evidencePath = path.join(root, "lane-evidence");

await fs.mkdir(root, { recursive: true });

const config = defaultLaneConfig();
const registry = defaultLaneRegistry();

await atomicJsonWrite(configPath, config);
await atomicJsonWrite(registryPath, registry);
await fs.rm(statusPath, { force: true });
await fs.writeFile(eventPath, "", "utf8");
await fs.rm(evidencePath, { recursive: true, force: true });

const lanesClean = config.lanes.every((lane) =>
  lane.enabled === false &&
  lane.brain_url === "" &&
  lane.work_url === "" &&
  lane.brain_url_revision === 0 &&
  lane.work_url_revision === 0 &&
  lane.work_state_reset_revision === 0 &&
  lane.relay_retry_rearm_revision === 0
);

const registryClean = Object.values(registry.lanes).every((lane) =>
  lane.task_id === null &&
  lane.dispatch_inflight === null &&
  lane.relay_inflight === null &&
  lane.brain_request_inflight === null &&
  lane.awaiting_work === false &&
  lane.pending_work_url === "" &&
  lane.last_result_relay_id === null &&
  lane.last_result_verdict === null
);

if (!lanesClean || !registryClean) {
  throw new Error("reset-all-projects default state verification failed");
}

console.log("RESET_ALL_PROJECTS_LANES_DISABLED=True");
console.log("RESET_ALL_PROJECTS_TARGETS_CLEARED=True");
console.log("RESET_ALL_PROJECTS_TASK_STATE_CLEARED=True");
console.log("RESET_ALL_PROJECTS_TIMELINE_CLEARED=True");
console.log("RESET_ALL_PROJECTS_EVIDENCE_CLEARED=True");
console.log("RESET_ALL_PROJECTS_BROWSER_PROFILE_PRESERVED=True");
