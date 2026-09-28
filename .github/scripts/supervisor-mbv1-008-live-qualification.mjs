import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import { sendComposerInstruction } from "../../src/ui/actions.mjs";
import {
  ChatGptBridgeAdapter
} from "../../src/runtime/chatgpt-bridge-adapter.mjs";
import {
  bindPlannerExecutorBridgePages
} from "../../src/runtime/chatgpt-bridge-binding.mjs";
import {
  injectPinnedBridgeUserscript
} from "../../src/runtime/chatgpt-bridge-page-runtime.mjs";

const cdpUrl = String(process.env.MBV1_008_CDP_URL || "");
const bridgeRoot = String(process.env.MBV1_008_BRIDGE_ROOT || "");
const bridgePython = String(process.env.MBV1_008_BRIDGE_PYTHON || "");
const originalBridgePid = Number(process.env.MBV1_008_BRIDGE_PID || 0);
const diagDir = String(process.env.MBV1_008_DIAG_DIR || "");
const revision = String(process.env.GITHUB_SHA || "unknown");

if (!cdpUrl || !bridgeRoot || !bridgePython || !diagDir || !originalBridgePid) {
  throw new Error("MBV1-008 live qualification environment is incomplete");
}

await fs.mkdir(diagDir, { recursive: true });
const userscript = await fs.readFile(
  path.join(bridgeRoot, "userscript", "chatgpt_bridge.user.js"),
  "utf8"
);
const resultPath = path.join(diagDir, revision + ".live.json");

function sha(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}
function log(key, value) {
  console.log(key + "=" + String(value ?? "").replace(/[\r\n|]+/g, " ").slice(0, 400));
}
async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError || new Error(label + " timeout");
}
async function waitBridgeHealthy(expected) {
  return waitFor(async () => {
    try {
      const r = await fetch("http://127.0.0.1:5000/status", {
        signal: AbortSignal.timeout(1500)
      });
      if (!r.ok) return !expected;
      await r.json();
      return expected;
    } catch {
      return !expected;
    }
  }, 20_000, "Bridge health transition");
}
async function waitConversationUrl(page) {
  return waitFor(async () => {
    const url = page.url();
    return /^https:\/\/chatgpt\.com\/c\/[0-9a-f-]{36}/i.test(url) ? url : false;
  }, 30_000, "ChatGPT conversation URL");
}
async function sendSetup(page, role) {
  const token = "MBV1_SETUP_" + role.toUpperCase() + "_" + crypto.randomBytes(4).toString("hex");
  const sent = await sendComposerInstruction(
    page,
    "MBV1-008 qualification setup only. Reply with exactly: " + token,
    { dryRun: false }
  );
  if (!sent?.executed) throw new Error(role + " setup send failed");
  const url = await waitConversationUrl(page);
  return { url, token };
}
async function waitBinding(bridge, plannerUrl, executorUrl) {
  return waitFor(
    () => bindPlannerExecutorBridgePages(bridge, {
      plannerUrl,
      executorUrl,
      requireExactPageSet: true
    }),
    20_000,
    "exact Bridge role binding"
  );
}
async function sendToken(bridge, pageId, role, suffix) {
  const token = "MBV1_008_" + role.toUpperCase() + "_" + suffix + "_" +
    crypto.randomBytes(5).toString("hex");
  const result = await bridge.send(
    pageId,
    "MBV1-008 harmless live transport qualification. Role: " + role +
      ". Reply with exactly this token and nothing else: " + token,
    { timeoutMs: 180_000 }
  );
  const reply = String(result?.snapshot?.last_assistant || "");
  if (!reply.includes(token)) throw new Error(role + " live token reply mismatch");
  return token;
}

const browser = new ChatGptUiAdapter({
  cdpUrl,
  settleMs: 500,
  actionTimeoutMs: 10_000,
  timeoutMs: 45_000
});
const bridge = new ChatGptBridgeAdapter({
  baseUrl: "http://127.0.0.1:5000",
  requestTimeoutMs: 10_000,
  responseTimeoutMs: 180_000,
  pollIntervalMs: 250
});

let plannerPage = null;
let executorPage = null;
let replacementBackend = null;
const startedAt = new Date().toISOString();

try {
  await browser.open();
  const preexisting = browser.getChatGptPages().length;
  if (preexisting > 2) {
    throw new Error("live qualification requires <=2 pre-existing ChatGPT pages");
  }
  plannerPage = await browser.newChatPage("https://chatgpt.com/");
  executorPage = await browser.newChatPage("https://chatgpt.com/");

  const [plannerSetup, executorSetup] = await Promise.all([
    sendSetup(plannerPage, "planner"),
    sendSetup(executorPage, "executor")
  ]);

  const bindingName = "__mbv1008BridgeHttp_" + crypto.randomBytes(5).toString("hex");
  await injectPinnedBridgeUserscript(plannerPage, userscript, { bindingName });
  await injectPinnedBridgeUserscript(executorPage, userscript, { bindingName });

  let binding = await waitBinding(bridge, plannerSetup.url, executorSetup.url);
  assertDistinct(binding);

  const plannerToken = await sendToken(
    bridge, binding.planner.page_id, "planner", "BASE"
  );
  const executorBefore = await bridge.getSnapshot(binding.executor.page_id);
  if (JSON.stringify(executorBefore).includes(plannerToken)) {
    throw new Error("Planner token crossed into Executor snapshot");
  }
  const executorToken = await sendToken(
    bridge, binding.executor.page_id, "executor", "BASE"
  );
  const plannerAfter = await bridge.getSnapshot(binding.planner.page_id);
  if (JSON.stringify(plannerAfter).includes(executorToken)) {
    throw new Error("Executor token crossed into Planner snapshot");
  }
  log("MBV1_008_LIVE_BASE_TRANSPORT", "PASS");
  log("MBV1_008_LIVE_ROLE_ISOLATION", "PASS");

  await plannerPage.reload({ waitUntil: "domcontentloaded" });
  await injectPinnedBridgeUserscript(plannerPage, userscript, { bindingName });
  binding = await waitBinding(bridge, plannerSetup.url, executorSetup.url);
  await sendToken(bridge, binding.planner.page_id, "planner", "RELOAD");
  log("MBV1_008_LIVE_PLANNER_RELOAD", "PASS");

  await executorPage.reload({ waitUntil: "domcontentloaded" });
  await injectPinnedBridgeUserscript(executorPage, userscript, { bindingName });
  binding = await waitBinding(bridge, plannerSetup.url, executorSetup.url);
  await sendToken(bridge, binding.executor.page_id, "executor", "RELOAD");
  log("MBV1_008_LIVE_EXECUTOR_RELOAD", "PASS");

  process.kill(originalBridgePid);
  await waitBridgeHealthy(false);
  replacementBackend = spawn(
    bridgePython,
    ["run.py", "--host", "127.0.0.1", "--port", "5000"],
    {
      cwd: bridgeRoot,
      windowsHide: true,
      stdio: "ignore"
    }
  );
  await waitBridgeHealthy(true);
  binding = await waitBinding(bridge, plannerSetup.url, executorSetup.url);
  await sendToken(bridge, binding.planner.page_id, "planner", "BRIDGE_RESTART");
  log("MBV1_008_LIVE_BRIDGE_RESTART", "PASS");

  const baseline = await bridge.captureBaseline(binding.planner.page_id);
  const longToken = "MBV1_008_LONG_" + crypto.randomBytes(5).toString("hex");
  await bridge.sendAsync(
    binding.planner.page_id,
    "MBV1-008 long-generation qualification. Write 80 numbered very short lines, one per line, then finish with exactly " +
      longToken
  );
  let sawGenerating = false;
  const finalLong = await waitFor(async () => {
    const snap = await bridge.getSnapshot(binding.planner.page_id);
    if (snap.is_generating) sawGenerating = true;
    const changed = snap.assistant_count > baseline.assistant_count;
    const done = changed && !snap.is_generating &&
      String(snap.last_assistant || "").includes(longToken);
    return done ? snap : false;
  }, 180_000, "long generation completion");
  if (!sawGenerating) {
    throw new Error("long-generation qualification never observed generating=true");
  }
  if (finalLong.is_generating) {
    throw new Error("long-generation parser completed while still generating");
  }
  log("MBV1_008_LIVE_LONG_GENERATION", "PASS");

  const result = {
    schema_version: "mbv1-008-live-qualification.v1",
    status: "PASS",
    task_id: "MBV1-008",
    candidate_revision: revision,
    target_computer: process.env.COMPUTERNAME || null,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    upstream_commit: "848efb9e85f52f251c82ab099747833c0693c072",
    normal_chat_count_owned: 2,
    preexisting_chat_count: preexisting,
    openai_api_required: false,
    chatgpt_work_mode_invocations: 0,
    base_transport: "PASS",
    role_isolation: "PASS",
    planner_reload: "PASS",
    executor_reload: "PASS",
    bridge_restart: "PASS",
    long_generation_no_premature_parse: "PASS",
    planner_target_digest: sha(plannerSetup.url),
    executor_target_digest: sha(executorSetup.url),
    production_state_mutated: false,
    production_targets_mutated: false
  };
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  log("MBV1_008_LIVE_STATUS", "PASS");
} catch (error) {
  await fs.writeFile(resultPath, JSON.stringify({
    schema_version: "mbv1-008-live-qualification.v1",
    status: "FAIL",
    task_id: "MBV1-008",
    candidate_revision: revision,
    target_computer: process.env.COMPUTERNAME || null,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    error_name: String(error?.name || "Error"),
    error_digest: sha(error?.message || error),
    production_state_mutated: false,
    production_targets_mutated: false
  }, null, 2) + "\n", "utf8").catch(() => {});
  log("MBV1_008_LIVE_STATUS", "FAIL");
  log("MBV1_008_LIVE_ERROR_DIGEST", sha(error?.message || error));
  throw error;
} finally {
  if (replacementBackend && !replacementBackend.killed) {
    replacementBackend.kill();
  }
  if (executorPage && !executorPage.isClosed()) {
    await browser.closePage(executorPage).catch(() => {});
  }
  if (plannerPage && !plannerPage.isClosed()) {
    await browser.closePage(plannerPage).catch(() => {});
  }
  await browser.close().catch(() => {});
}

function assertDistinct(binding) {
  if (
    !binding?.planner?.page_id ||
    !binding?.executor?.page_id ||
    binding.planner.page_id === binding.executor.page_id
  ) {
    throw new Error("Planner/Executor live Bridge page identities are not distinct");
  }
}
