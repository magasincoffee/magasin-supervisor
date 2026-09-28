import path from "node:path";
import process from "node:process";

import {
  ensureSingleConversationState,
  SINGLE_CONVERSATION_MODE
} from "./single-conversation-state.mjs";

function parseArgs(argv) {
  const out = {
    statePath: null,
    sourceOfTruthUrl: null,
    projectId: "LIVE"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--state") out.statePath = argv[++i];
    else if (arg === "--source-of-truth") out.sourceOfTruthUrl = argv[++i];
    else if (arg === "--project-id") out.projectId = argv[++i];
    else throw new Error("unknown argument: " + arg);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.statePath) throw new Error("--state is required");
if (!args.sourceOfTruthUrl) throw new Error("--source-of-truth is required");

const state = await ensureSingleConversationState(
  path.resolve(args.statePath),
  {
    sourceOfTruthUrl: args.sourceOfTruthUrl,
    projectId: args.projectId
  }
);

console.log("SINGLE_CONVERSATION_STATE=READY");
console.log("SINGLE_CONVERSATION_MODE=" + SINGLE_CONVERSATION_MODE);
console.log("SINGLE_CONVERSATION_PROJECT=" + state.project_id);
console.log("SINGLE_CONVERSATION_CHAT_URL_REQUIRED=False");
console.log("SINGLE_CONVERSATION_PLANNER_URL_REQUIRED=False");
console.log("SINGLE_CONVERSATION_EXECUTOR_URL_REQUIRED=False");
