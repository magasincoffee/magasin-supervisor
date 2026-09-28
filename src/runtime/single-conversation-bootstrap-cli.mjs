import path from "node:path";
import process from "node:process";

import { ChatGptUiAdapter } from "../ui/playwright-adapter.mjs";
import { createNewChatAndBootstrap } from "./single-conversation-bootstrap.mjs";

function parseArgs(argv) {
  const out = {
    statePath: null,
    sourceOfTruthUrl: null,
    cdpUrl: null,
    execute: false,
    timeoutMs: 180_000
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--state") out.statePath = argv[++i];
    else if (arg === "--source-of-truth") out.sourceOfTruthUrl = argv[++i];
    else if (arg === "--cdp-url") out.cdpUrl = argv[++i];
    else if (arg === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else if (arg === "--execute") out.execute = true;
    else throw new Error("unknown argument: " + arg);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.statePath) throw new Error("--state is required");
if (!args.sourceOfTruthUrl) throw new Error("--source-of-truth is required");
if (!args.cdpUrl) throw new Error("--cdp-url is required");
if (!args.execute) {
  console.log("SC003_EXECUTE_REQUIRED=True");
  console.log("SC003_CHAT_URL_REQUIRED=False");
  process.exit(0);
}

const adapter = new ChatGptUiAdapter({
  cdpUrl: args.cdpUrl,
  settleMs: 400,
  actionTimeoutMs: 10_000,
  timeoutMs: 45_000
});

try {
  const result = await createNewChatAndBootstrap({
    adapter,
    statePath: path.resolve(args.statePath),
    sourceOfTruthUrl: args.sourceOfTruthUrl,
    timeoutMs: args.timeoutMs
  });
  console.log("SC003_BOOTSTRAP_STATUS=" + result.response.status);
  console.log("SC003_CHAT_URL_REQUIRED=False");
  console.log("SC003_NEW_CHAT_CREATED=" + String(Boolean(result.surface.created || result.surface.reused_home)));
  console.log("SC003_USER_TURN_CONFIRMED=" + String(Boolean(result.send?.executed)));
} finally {
  await adapter.close().catch(() => {});
}
