import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";

const cdpUrl = String(process.env.MBV1_001_CDP_URL || "").trim();
const upstreamRoot = String(process.env.MBV1_001_UPSTREAM_ROOT || "").trim();
const upstreamCommit = String(process.env.MBV1_001_UPSTREAM_COMMIT || "").trim();
const diagDir = String(process.env.MBV1_001_DIAG_DIR || "").trim();
const revision = String(process.env.GITHUB_SHA || "unknown").trim();
const browserStartedByQualification =
  String(process.env.MBV1_001_BROWSER_STARTED || "").toLowerCase() === "true";

if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl)) {
  throw new Error("MBV1_001_CDP_URL must be a local CDP endpoint");
}
if (!upstreamRoot || !upstreamCommit || !diagDir) {
  throw new Error("MBV1-001 upstream/diagnostic environment is incomplete");
}

const userscriptPath = path.join(upstreamRoot, "userscript", "chatgpt_bridge.user.js");
const userscript = await fs.readFile(userscriptPath, "utf8");
if (!userscript.includes("const BACKEND_URL = 'http://127.0.0.1:5000'")) {
  throw new Error("Pinned userscript does not expose expected local backend URL");
}

await fs.mkdir(diagDir, { recursive: true });
const resultPath = path.join(
  diagDir,
  revision.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) + ".result.json"
);

function hash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function log(key, value) {
  const safe = String(value ?? "").replace(/[\r\n|]+/g, " ").slice(0, 500);
  console.log(key + "=" + safe);
}

async function bridgeJson(pathname, options = {}) {
  const response = await fetch("http://127.0.0.1:5000" + pathname, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || 190000)
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Bridge returned non-JSON for " + pathname);
  }
  if (!response.ok) {
    throw new Error("Bridge " + pathname + " failed HTTP " + response.status);
  }
  return payload;
}

async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  const intervalMs = options.intervalMs || 300;
  const label = options.label || "condition";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(label + " timeout");
}

async function installBridgeUserscript(page) {
  await page.exposeFunction("__mbv1BridgeHttp", async request => {
    const response = await fetch(String(request.url), {
      method: request.method || "GET",
      headers: request.headers || {},
      body: request.body || undefined,
      signal: AbortSignal.timeout(15000)
    });
    return {
      status: response.status,
      responseText: await response.text()
    };
  });

  await page.evaluate(() => {
    globalThis.GM_xmlhttpRequest = opts => {
      globalThis.__mbv1BridgeHttp({
        method: opts.method || "GET",
        url: opts.url,
        headers: opts.headers || {},
        body: opts.data
      }).then(result => {
        if (opts.onload) {
          opts.onload({
            status: result.status,
            responseText: result.responseText
          });
        }
      }).catch(error => {
        if (opts.onerror) {
          opts.onerror({ error: String(error && error.message ? error.message : error) });
        }
      });
    };
    globalThis.GM = { xmlHttpRequest: globalThis.GM_xmlhttpRequest };
  });

  await page.evaluate(source => {
    (0, eval)(source);
  }, userscript);
}

async function waitForLoginReady(adapter, page) {
  return waitFor(async () => {
    const probe = await adapter.probePage(page).catch(() => null);
    if (!probe) return false;
    if (probe.snapshot && (probe.snapshot.loginRequired || probe.snapshot.hasCaptcha)) {
      throw new Error("Authenticated ChatGPT session required for MBV1-001");
    }
    return probe.snapshot && probe.snapshot.hasComposer ? probe : false;
  }, { timeoutMs: 45000, label: "authenticated ChatGPT composer" });
}

async function bridgePagesExactlyTwo() {
  return waitFor(async () => {
    const payload = await bridgeJson("/pages", { timeoutMs: 5000 });
    const pages = Array.isArray(payload.pages) ? payload.pages.filter(p => p.alive) : [];
    if (pages.length !== 2) return false;
    if (!pages.every(p => p.page_id && String(p.url || "").includes("chatgpt.com"))) return false;
    if (pages[0].page_id === pages[1].page_id) return false;
    return pages;
  }, { timeoutMs: 20000, label: "two distinct Bridge pages" });
}

async function sendQualification(pageId, role, token) {
  const prompt = [
    "MBV1-001 harmless transport qualification.",
    "Role: " + role + ".",
    "Reply with exactly this token and nothing else: " + token
  ].join(" ");
  const result = await bridgeJson("/send", {
    method: "POST",
    body: { page_id: pageId, text: prompt },
    timeoutMs: 190000
  });
  if (!result || !result.ok) {
    throw new Error(role + " Bridge /send returned non-pass result");
  }
  const reply = String(result.reply || "").trim();
  if (!reply.includes(token)) {
    throw new Error(role + " reply did not contain qualification token");
  }
  return { prompt, reply };
}

async function snapshot(pageId) {
  return bridgeJson("/snapshot?page_id=" + encodeURIComponent(pageId), { timeoutMs: 5000 });
}

const adapter = new ChatGptUiAdapter({
  cdpUrl,
  settleMs: 600,
  actionTimeoutMs: 10000,
  timeoutMs: 45000
});

let plannerPage = null;
let executorPage = null;
const startedAt = new Date().toISOString();

try {
  const status = await bridgeJson("/status", { timeoutMs: 5000 });
  log("MBV1_001_BRIDGE_STATUS_PAGES_CONNECTED", status.pages_connected ?? "unknown");

  await adapter.open();
  const existingPages = adapter.getChatGptPages();
  const preexistingPages = existingPages.length;
  log("MBV1_001_PREEXISTING_CHATGPT_PAGES", preexistingPages);
  log("MBV1_001_BROWSER_STARTED_BY_QUALIFICATION", browserStartedByQualification);

  if (browserStartedByQualification) {
    if (preexistingPages > 1) {
      throw new Error("qualification-owned Chrome expected <=1 ChatGPT page; found " + preexistingPages);
    }
    plannerPage = existingPages[0] || await adapter.newChatPage("https://chatgpt.com/");
    executorPage = await adapter.newChatPage("https://chatgpt.com/");
  } else {
    if (preexistingPages > 2) {
      throw new Error("MBV1-001 requires <=2 pre-existing production ChatGPT pages; found " + preexistingPages);
    }
    plannerPage = await adapter.newChatPage("https://chatgpt.com/");
    executorPage = await adapter.newChatPage("https://chatgpt.com/");
  }

  await Promise.all([
    waitForLoginReady(adapter, plannerPage),
    waitForLoginReady(adapter, executorPage)
  ]);

  await plannerPage.evaluate(() => { document.title = "MBV1 Planner | " + document.title; });
  await executorPage.evaluate(() => { document.title = "MBV1 Executor | " + document.title; });

  await installBridgeUserscript(plannerPage);
  await installBridgeUserscript(executorPage);

  const pages = await bridgePagesExactlyTwo();
  const plannerBridge = pages.find(p => String(p.title || "").includes("MBV1 Planner")) || pages[0];
  const executorBridge =
    pages.find(p => p.page_id !== plannerBridge.page_id && String(p.title || "").includes("MBV1 Executor")) ||
    pages.find(p => p.page_id !== plannerBridge.page_id);

  if (!plannerBridge || !executorBridge || plannerBridge.page_id === executorBridge.page_id) {
    throw new Error("Could not deterministically bind two distinct Bridge page_id values");
  }

  log("MBV1_001_PLANNER_CONNECTED", "True");
  log("MBV1_001_EXECUTOR_CONNECTED", "True");
  log("MBV1_001_DISTINCT_PAGE_ID", "True");
  log("MBV1_001_PLANNER_PAGE_ID_DIGEST", hash(plannerBridge.page_id));
  log("MBV1_001_EXECUTOR_PAGE_ID_DIGEST", hash(executorBridge.page_id));

  const nonce = crypto.randomBytes(6).toString("hex");
  const plannerToken = "MBV1_PLANNER_PASS_" + nonce;
  const executorToken = "MBV1_EXECUTOR_PASS_" + nonce;

  const plannerRoundTrip = await sendQualification(plannerBridge.page_id, "Planner", plannerToken);
  log("MBV1_001_PLANNER_SEND_READ", "PASS");

  const executorSnapBefore = await snapshot(executorBridge.page_id);
  if (JSON.stringify(executorSnapBefore).includes(plannerToken)) {
    throw new Error("Planner qualification token leaked into Executor snapshot");
  }

  const executorRoundTrip = await sendQualification(executorBridge.page_id, "Executor", executorToken);
  log("MBV1_001_EXECUTOR_SEND_READ", "PASS");

  const plannerSnapFinal = await snapshot(plannerBridge.page_id);
  const executorSnapFinal = await snapshot(executorBridge.page_id);
  const plannerText = JSON.stringify(plannerSnapFinal);
  const executorText = JSON.stringify(executorSnapFinal);

  if (!plannerText.includes(plannerToken) || plannerText.includes(executorToken)) {
    throw new Error("Planner snapshot failed role-isolation evidence");
  }
  if (!executorText.includes(executorToken) || executorText.includes(plannerToken)) {
    throw new Error("Executor snapshot failed role-isolation evidence");
  }
  log("MBV1_001_ROLE_ISOLATION", "PASS");

  const result = {
    schema_version: "mbv1-001-live-baseline.v1",
    status: "PASS",
    task_id: "MBV1-001",
    supervisor_revision: revision,
    upstream_repository: "https://github.com/OLmatter/chatgpt-bridge",
    upstream_commit: upstreamCommit,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    target_computer: process.env.COMPUTERNAME || null,
    bridge_service_online: true,
    planner_connected: true,
    executor_connected: true,
    distinct_page_id: true,
    planner_send_read: "PASS",
    executor_send_read: "PASS",
    role_isolation: "PASS",
    planner_page_id_digest: hash(plannerBridge.page_id),
    executor_page_id_digest: hash(executorBridge.page_id),
    planner_prompt_digest: hash(plannerRoundTrip.prompt),
    planner_reply_digest: hash(plannerRoundTrip.reply),
    executor_prompt_digest: hash(executorRoundTrip.prompt),
    executor_reply_digest: hash(executorRoundTrip.reply),
    openai_api_required_for_transport: false,
    chatgpt_work_mode_invocations: 0,
    production_state_mutated: false,
    production_targets_mutated: false,
    tampermonkey_packaging_verified: false,
    qualification_injection: "PINNED_UPSTREAM_USERSCRIPT_VIA_CDP_WITH_GM_HTTP_SHIM"
  };

  await fs.writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  log("MBV1_001_STATUS", "PASS");
  log("MBV1_001_UPSTREAM_PIN_RECORDED", "True");
  log("MBV1_001_OPENAI_API_REQUIRED", "False");
  log("MBV1_001_PRODUCTION_STATE_MUTATED", "False");
  log("MBV1_001_PRODUCTION_TARGETS_MUTATED", "False");
} catch (error) {
  const result = {
    schema_version: "mbv1-001-live-baseline.v1",
    status: "FAIL",
    task_id: "MBV1-001",
    supervisor_revision: revision,
    upstream_repository: "https://github.com/OLmatter/chatgpt-bridge",
    upstream_commit: upstreamCommit,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    target_computer: process.env.COMPUTERNAME || null,
    error_name: String(error && error.name ? error.name : "Error"),
    error_digest: hash(String(error && error.message ? error.message : error)),
    production_state_mutated: false,
    production_targets_mutated: false
  };
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8").catch(() => {});
  log("MBV1_001_STATUS", "FAIL");
  log("MBV1_001_ERROR_NAME", error && error.name ? error.name : "Error");
  log("MBV1_001_ERROR_DIGEST", hash(String(error && error.message ? error.message : error)));
  throw error;
} finally {
  if (executorPage && !executorPage.isClosed()) {
    await adapter.closePage(executorPage).catch(() => {});
  }
  if (plannerPage && !plannerPage.isClosed()) {
    await adapter.closePage(plannerPage).catch(() => {});
  }
  await adapter.close().catch(() => {});
}
