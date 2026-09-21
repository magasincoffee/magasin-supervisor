import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { ACTIONS, decideContinuation } from "../decision.mjs";
import { inspectActionSurface } from "../ui/actions.mjs";
import { loadProjectInput } from "../project-adapter.mjs";
import { executeDecision } from "../ui/actions.mjs";
import { SupervisorSession } from "./session.mjs";
import { resolveSupervisorStateRoot } from "./state-root.mjs";

function localRoot() {
  return resolveSupervisorStateRoot().root;
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

const root = localRoot();
const target = validateTarget(JSON.parse(
  await fs.readFile(path.join(root, "target.json"), "utf8")
));
const projectState = await loadProjectInput();

const session = new SupervisorSession({
  cdpUrl: "http://127.0.0.1:9222",
  maxConnectRetries: 2
});

let output = {
  status: "NO_RETRY_NEEDED",
  executed: false
};

try {
  const adapter = await session.connect();
  const page = adapter.getActivePage();
  if (!page) throw new Error("no active ChatGPT page");

  const wanted = `${target.origin}${target.pathname}`;
  if (page.url() !== wanted) {
    await page.goto(wanted, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    });
    await page.waitForTimeout(1500);
  }

  let probe = null;
  let surface = null;

  for (let i = 0; i < 8; i += 1) {
    probe = await session.probe();
    surface = await inspectActionSurface(page);
    if (
      probe.classification.observation !== "UNKNOWN" ||
      surface.retryControl
    ) {
      break;
    }
    await page.waitForTimeout(1000);
  }

  const observation = surface?.retryControl
    ? "TRANSIENT_ERROR"
    : probe.classification.observation;

  const decision = decideContinuation({
    projectState,
    observation,
    retryCount: 0,
    maxRetries: 1
  });

  if (decision.action === ACTIONS.RETRY) {
    const execution = await executeDecision({
      page,
      decision,
      dryRun: false
    });

    output = {
      status: execution.executed ? "PASS" : "NO_SAFE_RETRY_CONTROL",
      uiState: probe.classification.uiState,
      observation,
      safeRetryPresent: Boolean(surface?.retryControl),
      composerReady: Boolean(surface?.composerReady),
      action: decision.action,
      executed: execution.executed,
      target: execution.target || null
    };

    if (!execution.executed) process.exitCode = 25;
  } else {
    output = {
      status: "NO_RETRY_NEEDED",
      uiState: probe.classification.uiState,
      observation,
      safeRetryPresent: Boolean(surface?.retryControl),
      composerReady: Boolean(surface?.composerReady),
      action: decision.action,
      executed: false
    };
  }

  console.log(JSON.stringify(output, null, 2));
} finally {
  await session.disconnect();
}

process.exit(process.exitCode ?? 0);
