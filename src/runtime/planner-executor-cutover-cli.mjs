import fs from "node:fs/promises";
import path from "node:path";

import { atomicJsonWrite } from "./atomic-json-write.mjs";
import { preparePlannerExecutorProductionCutover } from "./planner-executor-cutover.mjs";

function parseArgs(argv) {
  const out = {
    root: null,
    laneId: null,
    output: null,
    authorizedAt: null,
    sourceRevision: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") out.root = argv[++i];
    else if (arg === "--lane-id") out.laneId = argv[++i];
    else if (arg === "--output") out.output = argv[++i];
    else if (arg === "--authorized-at") out.authorizedAt = argv[++i];
    else if (arg === "--source-revision") out.sourceRevision = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.root || !args.laneId || !args.output) {
  throw new Error("--root, --lane-id and --output are required");
}

const candidate = await preparePlannerExecutorProductionCutover({
  root: path.resolve(args.root),
  laneId: args.laneId,
  authorizedAt: args.authorizedAt,
  sourceRevision: args.sourceRevision
});

await fs.mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
await atomicJsonWrite(path.resolve(args.output), candidate);

console.log("PE007_CUTOVER_CANDIDATE_WRITTEN=True");
console.log(`PE007_CUTOVER_SOURCE_LANE=${candidate.source_lane_id}`);
console.log(`PE007_CUTOVER_READY=${candidate.cutover_ready}`);
console.log(
  `PE007_CUTOVER_BLOCKERS=${candidate.blockers.length
    ? candidate.blockers.join(",")
    : "NONE"}`
);
