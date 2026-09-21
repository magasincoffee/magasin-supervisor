import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveSupervisorStateRoot } from "./state-root.mjs";
import { setTimeout as delay } from "node:timers/promises";

import { ACTIONS } from "../decision.mjs";
import { readProjectStateFromAdapter } from "../project-adapter.mjs";
import { SupervisorSession } from "./session.mjs";
import { runSupervisorStep } from "./step.mjs";

function parseArgs(argv) {
  const result = {
    cdpUrl: "http://127.0.0.1:9222",
    execute: false,
    waitSeconds: 300,
    pollMs: 2000
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--cdp-url") result.cdpUrl = argv[++i];
    else if (key === "--project-adapter") result.projectAdapter = argv[++i];
    else if (key === "--target") result.targetPath = argv[++i];
    else if (key === "--execute") result.execute = true;
    else if (key === "--wait-seconds") result.waitSeconds = Number(argv[++i]);
    else if (key === "--poll-ms") result.pollMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${key}`);
  }
  return result;
}

function localTargetPath() {
  return path.join(resolveSupervisorStateRoot(process.env), "target.json");
}

function validateTarget(value) {
  if (!value || value.origin !== "https://chatgpt.com") {
    throw new Error("invalid local ChatGPT target origin");
  }
  if (typeof value.pathname !== "string" ||
      !/^\/(c|g|project)\//.test(value.pathname)) {
    throw new Error("invalid local ChatGPT target path");
  }
  return value;
}

const args = parseArgs(process.argv.slice(2));
if (!Number.isFinite(args.waitSeconds) || args.waitSeconds < 0) {
  throw new TypeError("wait-seconds must be non-negative");
}
if (!Number.isFinite(args.pollMs) || args.pollMs < 250) {
  throw new TypeError("poll-ms must be at least 250");
}

if (!args.projectAdapter) throw new Error("--project-adapter is required");
const target = validateTarget(JSON.parse(
  await fs.readFile(args.targetPath || localTargetPath(), "utf8")
));
const projectState = await readProjectStateFromAdapter(args.projectAdapter || projectAdapter);
const session = new SupervisorSession({
  cdpUrl: args.cdpUrl,
  maxConnectRetries: 2
});

const deadline = Date.now() + (args.waitSeconds * 1000);
let terminal = null;

try {
  const adapter = await session.connect();
  const page = adapter.getActivePage();
  if (!page) throw new Error("no active browser page");

  const wanted = `${target.origin}${target.pathname}`;
  if (page.url() !== wanted) {
    await page.goto(wanted, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    });
    await page.waitForTimeout(1500);
  }

  while (Date.now() <= deadline) {
    const result = await runSupervisorStep({
      session,
      projectState,
      dryRun: !args.execute
    });

    const action = result.decision.action;
    const execution = result.execution;

    if (action === ACTIONS.STOP_WAIT_USER || action === ACTIONS.STOP_DONE) {
      terminal = {
        status: "STOPPED",
        action,
        executed: false
      };
      break;
    }

    if (action === ACTIONS.CONTINUE || action === ACTIONS.RETRY) {
      terminal = {
        status: execution.executed || !args.execute ? "PASS" : "NO_SAFE_ACTION",
        action,
        executed: execution.executed,
        dryRun: execution.dryRun,
        target: execution.target || null
      };
      break;
    }

    await delay(args.pollMs);
  }

  if (!terminal) {
    terminal = {
      status: "TIMEOUT",
      action: ACTIONS.WAIT,
      executed: false
    };
    process.exitCode = 25;
  }

  console.log(JSON.stringify(terminal, null, 2));
} finally {
  await session.disconnect();
}

// connectOverCDP keeps a websocket handle alive even after logical detach.
// Short-lived CI CLIs must terminate explicitly without closing real Chrome.
process.exit(process.exitCode ?? 0);
