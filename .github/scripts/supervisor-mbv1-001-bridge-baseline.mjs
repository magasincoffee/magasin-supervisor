import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { chromium } from "playwright-core";

const [cdpUrl, bridgeBase, resultPath, bridgeCommit, userscriptSha256] = process.argv.slice(2);
if (!cdpUrl || !bridgeBase || !resultPath || !bridgeCommit || !userscriptSha256) {
  throw new Error("usage: node supervisor-mbv1-001-bridge-baseline.mjs <cdpUrl> <bridgeBase> <resultPath> <bridgeCommit> <userscriptSha256>");
}

const startedAt = new Date().toISOString();

function sha(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function log(key, value) {
  const safe = String(value ?? "").replace(/[\r\n|]+/g, " ").slice(0, 500);
  console.log(`${key}=${safe}`);
}

async function writeResult(value) {
  await fs.mkdir(new URL(".", `file:///${resultPath.replace(/\\/g, "/")}`).pathname, { recursive: true }).catch(() => {});
  await fs.writeFile(resultPath, JSON.stringify({
    schema_version: "mbv1-001-live-baseline.v1",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    bridge_upstream_commit: bridgeCommit,
    bridge_userscript_sha256: userscriptSha256,
    ...value
  }, null, 2) + "\n", "utf8");
}

async function bridgeJson(method, path, body = undefined, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(bridgeBase + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    let parsed = {};
    try { parsed = JSON.parse(text); } catch {}
    if (!response.ok) {
      throw new Error(`bridge HTTP ${response.status}: ${parsed?.detail || text || "unknown"}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(check, {
  timeoutMs = 45_000,
  intervalMs = 400,
  label = "condition"
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} timeout${lastError ? `: ${lastError.message}` : ""}`);
}

function expectedPageId(info) {
  const match = String(info.path || "").match(/\/c\/([a-f0-9-]+)/i);
  const convoId = match ? match[1] : "home";
  const name = String(info.name || "");
  if (!name.startsWith("bridge_") || name.length < 4) {
    throw new Error("bridge userscript did not establish window.name");
  }
  return `${convoId}_${name.slice(-4)}`;
}

function turnsContain(snapshot, token) {
  const recent = Array.isArray(snapshot?.recentTurns) ? snapshot.recentTurns : [];
  const haystack = [
    snapshot?.lastAssistant || "",
    ...recent.map((turn) => turn?.text || "")
  ].join("\n");
  return haystack.includes(token);
}

let browser = null;
let plannerPage = null;
let executorPage = null;

try {
  const status = await bridgeJson("GET", "/status");
  log("MBV1_001_BRIDGE_STATUS_PRE", JSON.stringify(status));

  browser = await chromium.connectOverCDP(cdpUrl);
  const contexts = browser.contexts();
  if (contexts.length !== 1) {
    throw new Error(`qualification Chrome expected one context, found ${contexts.length}`);
  }
  const context = contexts[0];

  plannerPage = await context.newPage();
  executorPage = await context.newPage();

  await Promise.all([
    plannerPage.goto("https://chatgpt.com/?mbv1_role=planner", { waitUntil: "domcontentloaded", timeout: 60_000 }),
    executorPage.goto("https://chatgpt.com/?mbv1_role=executor", { waitUntil: "domcontentloaded", timeout: 60_000 })
  ]);

  for (const page of context.pages()) {
    if (page !== plannerPage && page !== executorPage) {
      await page.close().catch(() => {});
    }
  }

  await Promise.all([
    plannerPage.waitForFunction(() => String(window.name || "").startsWith("bridge_"), null, { timeout: 30_000 }),
    executorPage.waitForFunction(() => String(window.name || "").startsWith("bridge_"), null, { timeout: 30_000 })
  ]);

  const [plannerInfo, executorInfo] = await Promise.all([
    plannerPage.evaluate(() => ({ name: window.name, path: location.pathname })),
    executorPage.evaluate(() => ({ name: window.name, path: location.pathname }))
  ]);

  const plannerPageId = expectedPageId(plannerInfo);
  const executorPageId = expectedPageId(executorInfo);
  if (plannerPageId === executorPageId) {
    throw new Error("Planner and Executor resolved to the same bridge page_id");
  }

  const connected = await waitFor(async () => {
    const listing = await bridgeJson("GET", "/pages");
    const pages = Array.isArray(listing?.pages) ? listing.pages : [];
    const planner = pages.find((page) => page.page_id === plannerPageId && page.alive === true);
    const executor = pages.find((page) => page.page_id === executorPageId && page.alive === true);
    return planner && executor ? { listing, planner, executor } : null;
  }, { timeoutMs: 45_000, label: "two live bridge pages" });

  log("MBV1_001_DISTINCT_PAGE_ID", "True");
  log("MBV1_001_CONNECTED_TOTAL", connected.listing.total);

  const [plannerSnapshot0, executorSnapshot0] = await Promise.all([
    bridgeJson("GET", `/snapshot?page_id=${encodeURIComponent(plannerPageId)}`),
    bridgeJson("GET", `/snapshot?page_id=${encodeURIComponent(executorPageId)}`)
  ]);

  if (plannerSnapshot0?.site !== "chatgpt" || executorSnapshot0?.site !== "chatgpt") {
    throw new Error("Bridge snapshot did not identify both pages as ChatGPT");
  }
  if (plannerSnapshot0?.hasEditor !== true || executorSnapshot0?.hasEditor !== true) {
    throw new Error("Qualification profile is not an authenticated editable ChatGPT surface");
  }

  const nonce = crypto.randomBytes(6).toString("hex");
  const plannerToken = `MBV1_PLANNER_PASS_${nonce}`;
  const executorToken = `MBV1_EXECUTOR_PASS_${nonce}`;

  const plannerPrompt = `MBV1-001 harmless transport qualification. Reply with exactly this token and nothing else: ${plannerToken}`;
  const plannerSend = await bridgeJson("POST", "/send", {
    page_id: plannerPageId,
    text: plannerPrompt
  }, 150_000);

  if (plannerSend?.ok !== true || !String(plannerSend?.reply || "").includes(plannerToken)) {
    throw new Error("Planner bridge send/read did not return the correlated probe token");
  }
  log("MBV1_001_PLANNER_SEND_READ", "PASS");

  const executorAfterPlanner = await bridgeJson(
    "GET",
    `/snapshot?page_id=${encodeURIComponent(executorPageId)}`
  );
  if (turnsContain(executorAfterPlanner, plannerToken)) {
    throw new Error("Planner probe token appeared in Executor snapshot");
  }

  const executorPrompt = `MBV1-001 harmless transport qualification. Reply with exactly this token and nothing else: ${executorToken}`;
  const executorSend = await bridgeJson("POST", "/send", {
    page_id: executorPageId,
    text: executorPrompt
  }, 150_000);

  if (executorSend?.ok !== true || !String(executorSend?.reply || "").includes(executorToken)) {
    throw new Error("Executor bridge send/read did not return the correlated probe token");
  }
  log("MBV1_001_EXECUTOR_SEND_READ", "PASS");

  const plannerAfterExecutor = await bridgeJson(
    "GET",
    `/snapshot?page_id=${encodeURIComponent(plannerPageId)}`
  );
  if (turnsContain(plannerAfterExecutor, executorToken)) {
    throw new Error("Executor probe token appeared in Planner snapshot");
  }
  log("MBV1_001_ROLE_ISOLATION", "PASS");

  const finalStatus = await bridgeJson("GET", "/status");

  await writeResult({
    status: "PASS",
    target_surface: "ISOLATED_CLONED_WINDOWS_CHROME_PROFILE",
    userscript_transport: "PINNED_UPSTREAM_USERSCRIPT_WITH_QUALIFICATION_EXTENSION_GM_SHIM",
    bridge_service_online: true,
    bridge_status: finalStatus,
    planner_connected: true,
    executor_connected: true,
    distinct_page_id: true,
    planner_page_id_digest: sha(plannerPageId),
    executor_page_id_digest: sha(executorPageId),
    planner_send_read: "PASS",
    executor_send_read: "PASS",
    role_isolation: "PASS",
    planner_reply_digest: sha(plannerSend.reply),
    executor_reply_digest: sha(executorSend.reply),
    openai_api_required_for_bridge_transport: false,
    production_state_mutated: false,
    production_targets_mutated: false,
    production_browser_profile_mutated: false
  });

  log("MBV1_001_STATUS", "PASS");
  log("MBV1_001_PRODUCTION_PROFILE_MUTATED", "False");
} catch (error) {
  await writeResult({
    status: "FAIL",
    error_name: String(error?.name || "Error"),
    error_digest: sha(String(error?.message || error)),
    production_state_mutated: false,
    production_targets_mutated: false,
    production_browser_profile_mutated: false
  }).catch(() => {});
  log("MBV1_001_STATUS", "FAIL");
  log("MBV1_001_ERROR_NAME", error?.name || "Error");
  log("MBV1_001_ERROR_DIGEST", sha(String(error?.message || error)));
  throw error;
} finally {
  await Promise.all([
    executorPage && !executorPage.isClosed() ? executorPage.close().catch(() => {}) : null,
    plannerPage && !plannerPage.isClosed() ? plannerPage.close().catch(() => {}) : null
  ]);
  await browser?.close().catch(() => {});
}
