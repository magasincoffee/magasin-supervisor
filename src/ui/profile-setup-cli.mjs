import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import {
  ChatGptUiAdapter,
  defaultSupervisorProfileDir,
  isChatGptUrl,
  isTransientNavigationError,
  resolveChromeExecutable
} from "./playwright-adapter.mjs";

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--cdp-url") result.cdpUrl = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const profileDir = defaultSupervisorProfileDir();
const targetFile = path.join(path.dirname(profileDir), "target.json");
const timeoutMs = 15 * 60 * 1000;
const pollMs = 2_000;

const adapter = new ChatGptUiAdapter({
  profileDir,
  chromeExecutable: resolveChromeExecutable(),
  url: "https://chatgpt.com/",
  headless: false,
  timeoutMs: 60_000,
  settleMs: 1_500,
  cdpUrl: args.cdpUrl || null
});

const started = Date.now();
let lastState = null;
let captured = false;

try {
  await adapter.open();
  console.log("SETUP_READY: use this Chrome window to sign in, then open the MAGASIN project conversation.");
  console.log("No credentials, cookies, tokens, or message text will be captured.");

  while (Date.now() - started < timeoutMs) {
    const activePage = adapter.getActivePage();

    if (!activePage) {
      console.error("SETUP_BROWSER_CLOSED: no browser page remains open.");
      process.exitCode = 25;
      break;
    }

    if (!isChatGptUrl(activePage.url())) {
      if (lastState !== "AUTH_NAVIGATION") {
        console.log("UI_STATE=AUTH_NAVIGATION");
        lastState = "AUTH_NAVIGATION";
      }
      await delay(pollMs);
      continue;
    }

    let result;
    try {
      result = await adapter.probe();
    } catch (error) {
      if (isTransientNavigationError(error)) {
        if (lastState !== "NAVIGATING") {
          console.log("UI_STATE=NAVIGATING");
          lastState = "NAVIGATING";
        }
        await delay(pollMs);
        continue;
      }
      throw error;
    }

    const { snapshot, classification } = result;

    if (classification.uiState !== lastState) {
      console.log(`UI_STATE=${classification.uiState}`);
      lastState = classification.uiState;
    }

    if (snapshot.conversationPath) {
      const currentUrl = new URL(adapter.getActivePage().url());
      await fs.mkdir(path.dirname(targetFile), { recursive: true });
      await fs.writeFile(
        targetFile,
        JSON.stringify({
          origin: currentUrl.origin,
          pathname: currentUrl.pathname,
          capturedAt: new Date().toISOString()
        }, null, 2) + "\n",
        "utf8"
      );

      console.log("SETUP_PASS: authenticated conversation target stored locally.");
      console.log("TARGET_STORAGE=LOCAL_ONLY");
      captured = true;
      process.exitCode = 0;
      break;
    }

    await delay(pollMs);
  }

  if (!captured && process.exitCode !== 25) {
    console.error("SETUP_TIMEOUT: conversation target was not detected within 15 minutes.");
    process.exitCode = 25;
  }
} finally {
  await adapter.close();
}
