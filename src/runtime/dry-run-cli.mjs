import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { loadProjectInput, selectProjectInputSource } from "../project-adapter.mjs";
import { supervisorStateRoot } from "../state-root.mjs";
import { SupervisorSession } from "./session.mjs";
import { runSupervisorStep } from "./step.mjs";

function parseArgs(argv) {
  const result = {
    cdpUrl: "http://127.0.0.1:9222"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--cdp-url") result.cdpUrl = argv[++i];
    else if (key === "--project-input-file" || key === "--state") result.projectInputFile = argv[++i];
    else if (key === "--project-input-url") result.projectInputUrl = argv[++i];
    else if (key === "--target") result.targetPath = argv[++i];
    else throw new Error(`unknown argument: ${key}`);
  }
  return result;
}

function defaultTargetPath() {
  return path.join(supervisorStateRoot(), "target.json");
}

function validateLocalTarget(value) {
  if (!value || typeof value !== "object") throw new Error("invalid local target");
  if (value.origin !== "https://chatgpt.com") throw new Error("unexpected target origin");
  if (typeof value.pathname !== "string" ||
      !/^\/(c|g|project)\//.test(value.pathname)) {
    throw new Error("unexpected target pathname");
  }
  return value;
}

const args = parseArgs(process.argv.slice(2));
const targetPath = args.targetPath || defaultTargetPath();

const target = validateLocalTarget(
  JSON.parse(await fs.readFile(targetPath, "utf8"))
);
selectProjectInputSource({
  filePath: args.projectInputFile,
  url: args.projectInputUrl
});
const projectState = await loadProjectInput({
  filePath: args.projectInputFile,
  url: args.projectInputUrl
});

const session = new SupervisorSession({
  cdpUrl: args.cdpUrl,
  maxConnectRetries: 2
});

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

  const result = await runSupervisorStep({
    session,
    projectState,
    dryRun: true
  });

  console.log(JSON.stringify({
    status: "PASS",
    uiState: result.probe.classification.uiState,
    observation: result.probe.classification.observation,
    decision: result.decision.action,
    plannedTarget: result.execution.target || null,
    executed: result.execution.executed,
    dryRun: result.execution.dryRun
  }, null, 2));
} finally {
  await session.disconnect();
}

// connectOverCDP keeps a websocket handle alive even after logical detach.
// Short-lived CI CLIs must terminate explicitly without closing real Chrome.
process.exit(process.exitCode ?? 0);
