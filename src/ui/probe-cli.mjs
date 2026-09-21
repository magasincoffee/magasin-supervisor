import path from "node:path";
import process from "node:process";

import {
  ChatGptUiAdapter,
  defaultSupervisorProfileDir,
  resolveChromeExecutable
} from "./playwright-adapter.mjs";

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--profile-dir") result.profileDir = argv[++i];
    else if (key === "--chrome") result.chromeExecutable = argv[++i];
    else if (key === "--url") result.url = argv[++i];
    else if (key === "--headless") result.headless = true;
    else if (key === "--cdp-url") result.cdpUrl = argv[++i];
    else throw new Error(`unknown argument: ${key}`);
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const adapter = new ChatGptUiAdapter({
  profileDir: args.profileDir
    ? path.resolve(args.profileDir)
    : defaultSupervisorProfileDir(),
  chromeExecutable: args.chromeExecutable || resolveChromeExecutable(),
  url: args.url || "https://chatgpt.com/",
  headless: Boolean(args.headless),
  cdpUrl: args.cdpUrl || null
});

try {
  await adapter.open();
  const result = await adapter.probe();
  console.log(JSON.stringify({
    gate: "CAPTURED",
    classification: result.classification,
    snapshot: result.snapshot,
    sideEffects: {
      messageSent: false,
      controlClicked: false,
      credentialsRead: false,
      messageTextCaptured: false
    }
  }, null, 2));
} finally {
  await adapter.close();
}
