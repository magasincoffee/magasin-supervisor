import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { chromium } from "playwright-core";

const [cdpUrl, bridgeBase, resultPath, bridgeCommit, userscriptSha256, userscriptPath] = process.argv.slice(2);
if (!cdpUrl || !bridgeBase || !resultPath || !bridgeCommit || !userscriptSha256 || !userscriptPath) {
  throw new Error("usage: node supervisor-mbv1-001-bridge-baseline.mjs <cdpUrl> <bridgeBase> <resultPath> <bridgeCommit> <userscriptSha256> <userscriptPath>");
}

const upstreamUserscriptText = await fs.readFile(userscriptPath, "utf8");
const expectedBridgeOrigin = new URL(bridgeBase).origin;

function applyPinnedCompatibilityOverlay(source) {
  const needle = ': [\'button[data-testid="send-button"]\', \'button[aria-label="发送"]\', \'button[aria-label="Send"]\', \'form button[type="submit"]\'];';
  const replacement = ': [\'button[data-testid="send-button"]\', \'button#composer-submit-button\', \'button[data-testid="composer-submit-button"]\', \'button[data-testid="composer-send-button"]\', \'button[aria-label="发送"]\', \'button[aria-label="Send"]\', \'form button[type="submit"]\'];';
  if (!source.includes(needle)) {
    throw new Error("pinned upstream ChatGPT send-selector block no longer matches expected commit");
  }
  let patched = source.replace(needle, replacement);

  const inputPattern = /([ \t]*editor\.innerHTML = '';\r?\n[ \t]*document\.execCommand\('insertText', false, text\);)/;
  if (!inputPattern.test(patched)) {
    throw new Error("pinned upstream ChatGPT contenteditable input block no longer matches expected commit");
  }
  patched = patched.replace(inputPattern, (match) => [
    match,
    "      if (!(editor.innerText || editor.textContent || '').trim()) {",
    "        editor.textContent = text;",
    "      }",
    "      try {",
    "        editor.dispatchEvent(new InputEvent('input', {",
    "          bubbles: true,",
    "          inputType: 'insertText',",
    "          data: text",
    "        }));",
    "      } catch {",
    "        editor.dispatchEvent(new Event('input', { bubbles: true }));",
    "      }"
  ].join("\n"));
  const settleNeedle = "    await sleep(400);\n    // Enter";
  const settleReplacement = [
    "    await sleep(400);",
    "    (globalThis.__mbv1BridgeStages ||= []).push({",
    "      stage: 'MBV1_STAGE_AFTER_INPUT_SETTLE',",
    "      text: (editor.innerText || editor.value || editor.textContent || '').slice(0, 300)",
    "    });",
    "    // Enter"
  ].join("\n");
  if (!patched.includes(settleNeedle)) {
    throw new Error("pinned upstream post-input settle block no longer matches expected commit");
  }
  patched = patched.replace(settleNeedle, settleReplacement);

  const enterNeedle = "    await sleep(2000);\n    if ((editor.innerText || editor.value || '').trim().length > 0) {";
  const enterReplacement = [
    "    await sleep(2000);",
    "    (globalThis.__mbv1BridgeStages ||= []).push({",
    "      stage: 'MBV1_STAGE_AFTER_ENTER_WAIT',",
    "      text: (editor.innerText || editor.value || editor.textContent || '').slice(0, 300)",
    "    });",
    "    if ((editor.innerText || editor.value || '').trim().length > 0) {"
  ].join("\n");
  if (!patched.includes(enterNeedle)) {
    throw new Error("pinned upstream post-enter block no longer matches expected commit");
  }
  patched = patched.replace(enterNeedle, enterReplacement);
  return patched;
}

const userscriptText = applyPinnedCompatibilityOverlay(upstreamUserscriptText);
const compatibilityOverlaySha256 = sha(userscriptText);

const startedAt = new Date().toISOString();

function sha(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function log(key, value) {
  const safe = String(value ?? "").replace(/[\r\n|]+/g, " ").slice(0, 500);
  console.log(`${key}=${safe}`);
}

async function writeResult(value) {
  await fs.mkdir(path.dirname(resultPath), { recursive: true });
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

function snapshotRoleContains(snapshot, role, token) {
  const recent = Array.isArray(snapshot?.recentTurns) ? snapshot.recentTurns : [];
  if (role === "assistant" && String(snapshot?.lastAssistant || "").includes(token)) {
    return true;
  }
  return recent.some((turn) =>
    String(turn?.role || "") === role &&
    String(turn?.text || "").includes(token)
  );
}

async function waitForBridgeTurn(pageId, role, token, timeoutMs) {
  return waitFor(async () => {
    const snapshot = await bridgeJson(
      "GET",
      `/snapshot?page_id=${encodeURIComponent(pageId)}`
    );
    return snapshotRoleContains(snapshot, role, token) ? snapshot : null;
  }, {
    timeoutMs,
    intervalMs: 500,
    label: `${role} turn containing qualification token`
  });
}

async function logChatSurfaceDiagnostics(page, label) {
  const diag = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" &&
        rect.width > 0 && rect.height > 0;
    };
    const editors = Array.from(document.querySelectorAll(
      '#prompt-textarea, div[contenteditable="true"], textarea[name="prompt-textarea"], #prosemirror-editor-container [contenteditable]'
    )).filter(visible).slice(0, 12).map((el) => ({
      tag: el.tagName,
      id: el.id || null,
      role: el.getAttribute("role"),
      contenteditable: el.getAttribute("contenteditable"),
      ariaLabel: el.getAttribute("aria-label"),
      testId: el.getAttribute("data-testid"),
      textLength: String(el.innerText || el.value || "").length
    }));
    const buttons = Array.from(document.querySelectorAll("button")).filter(visible)
      .slice(-80).map((el) => ({
        id: el.id || null,
        type: el.getAttribute("type"),
        ariaLabel: el.getAttribute("aria-label"),
        testId: el.getAttribute("data-testid"),
        disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true",
        text: String(el.innerText || el.textContent || "").trim().slice(0, 80)
      }));
    const sendCandidates = buttons.filter((b) =>
      /(send|submit|gửi|composer|prompt)/i.test(
        [b.id, b.type, b.ariaLabel, b.testId, b.text].filter(Boolean).join(" ")
      )
    );
    return { editors, buttons, sendCandidates };
  });
  log(`MBV1_001_${label}_EDITORS`, JSON.stringify(diag.editors));
  log(`MBV1_001_${label}_SEND_CANDIDATES`, JSON.stringify(diag.sendCandidates));
  return diag;
}

async function installUserscriptTransport(context, page) {
  await context.exposeBinding("__mbv1BridgeRequest", async (_source, request = {}) => {
    const target = new URL(String(request.url || ""));
    if (target.origin !== expectedBridgeOrigin) {
      throw new Error("qualification GM bridge rejected non-local target");
    }

    const controller = new AbortController();
    const timeoutMs = Math.max(1, Number(request.timeout || 10_000));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(target, {
        method: String(request.method || "GET"),
        headers: request.headers || {},
        body: request.body == null ? undefined : String(request.body),
        signal: controller.signal
      });
      return {
        status: response.status,
        responseText: await response.text()
      };
    } finally {
      clearTimeout(timer);
    }
  }).catch((error) => {
    if (!String(error?.message || error).includes("has been already registered")) throw error;
  });

  await page.evaluate(() => {
    globalThis.GM_xmlhttpRequest = function mbv1GmXmlHttpRequest(options = {}) {
      const timeoutMs = Math.max(1, Number(options.timeout || 10_000));
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (typeof options.ontimeout === "function") options.ontimeout();
      }, timeoutMs + 500);

      globalThis.__mbv1BridgeRequest({
        method: options.method || "GET",
        url: String(options.url || ""),
        headers: options.headers || {},
        body: options.data == null ? null : options.data,
        timeout: timeoutMs
      }).then((response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (typeof options.onload === "function") {
          options.onload({
            status: response.status,
            responseText: response.responseText || ""
          });
        }
      }).catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (typeof options.onerror === "function") options.onerror(error);
      });
    };
    globalThis.GM = {
      ...(globalThis.GM || {}),
      xmlHttpRequest: globalThis.GM_xmlhttpRequest
    };
  });

  const runner = new Function(userscriptText);
  await page.evaluate(runner);
}

let browser = null;
let qualificationContext = null;
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
  const sourceContext = contexts[0];
  const preexistingPages = sourceContext.pages().slice();
  log("MBV1_001_PRODUCTION_CONTEXT_PAGES", preexistingPages.length);

  const storageState = await sourceContext.storageState();
  qualificationContext = await browser.newContext({ storageState });
  log("MBV1_001_QUALIFICATION_CONTEXT", "ISOLATED");

  plannerPage = await qualificationContext.newPage();
  executorPage = await qualificationContext.newPage();

  await Promise.all([
    plannerPage.goto("https://chatgpt.com/?mbv1_role=planner", { waitUntil: "domcontentloaded", timeout: 60_000 }),
    executorPage.goto("https://chatgpt.com/?mbv1_role=executor", { waitUntil: "domcontentloaded", timeout: 60_000 })
  ]);

  await installUserscriptTransport(qualificationContext, plannerPage);
  await installUserscriptTransport(qualificationContext, executorPage);

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

  const editable = await waitFor(async () => {
    const [plannerSnapshot, executorSnapshot] = await Promise.all([
      bridgeJson("GET", `/snapshot?page_id=${encodeURIComponent(plannerPageId)}`),
      bridgeJson("GET", `/snapshot?page_id=${encodeURIComponent(executorPageId)}`)
    ]);
    if (plannerSnapshot?.site !== "chatgpt" || executorSnapshot?.site !== "chatgpt") {
      return null;
    }
    if (plannerSnapshot?.hasEditor === true && executorSnapshot?.hasEditor === true) {
      return { plannerSnapshot, executorSnapshot };
    }
    return null;
  }, { timeoutMs: 30_000, label: "authenticated editable ChatGPT surfaces" });

  if (!editable) {
    throw new Error("Qualification did not reach authenticated editable ChatGPT surfaces");
  }
  log("MBV1_001_AUTHENTICATED_EDITORS", "PASS");

  const nonce = crypto.randomBytes(6).toString("hex");
  const plannerToken = `MBV1_PLANNER_PASS_${nonce}`;
  const executorToken = `MBV1_EXECUTOR_PASS_${nonce}`;

  await logChatSurfaceDiagnostics(plannerPage, "PLANNER_PRE_SEND");
  const plannerPrompt = `MBV1-001 harmless transport qualification. Reply with exactly this token and nothing else: ${plannerToken}`;
  const plannerDispatch = await bridgeJson("POST", "/send_async", {
    page_id: plannerPageId,
    text: plannerPrompt
  }, 20_000);
  if (plannerDispatch?.ok !== true || !plannerDispatch?.cmd_id) {
    throw new Error("Planner bridge async dispatch was not accepted");
  }
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const plannerPostDispatchSnapshot = await bridgeJson(
    "GET",
    `/snapshot?page_id=${encodeURIComponent(plannerPageId)}`
  );
  log("MBV1_001_PLANNER_POST_DISPATCH_EDITOR", plannerPostDispatchSnapshot?.editorText || "");
  log("MBV1_001_PLANNER_POST_DISPATCH_GENERATING", plannerPostDispatchSnapshot?.isGenerating);
  const bridgeStages = await plannerPage.evaluate(() => globalThis.__mbv1BridgeStages || []);
  log("MBV1_001_PLANNER_BRIDGE_STAGES", JSON.stringify(bridgeStages));
  await logChatSurfaceDiagnostics(plannerPage, "PLANNER_POST_DISPATCH");
  await waitForBridgeTurn(plannerPageId, "user", plannerToken, 20_000);
  const plannerReplySnapshot = await waitForBridgeTurn(
    plannerPageId,
    "assistant",
    plannerToken,
    120_000
  );
  log("MBV1_001_PLANNER_SEND_READ", "PASS");

  const executorAfterPlanner = await bridgeJson(
    "GET",
    `/snapshot?page_id=${encodeURIComponent(executorPageId)}`
  );
  if (turnsContain(executorAfterPlanner, plannerToken)) {
    throw new Error("Planner probe token appeared in Executor snapshot");
  }

  const executorPrompt = `MBV1-001 harmless transport qualification. Reply with exactly this token and nothing else: ${executorToken}`;
  const executorDispatch = await bridgeJson("POST", "/send_async", {
    page_id: executorPageId,
    text: executorPrompt
  }, 20_000);
  if (executorDispatch?.ok !== true || !executorDispatch?.cmd_id) {
    throw new Error("Executor bridge async dispatch was not accepted");
  }
  await waitForBridgeTurn(executorPageId, "user", executorToken, 20_000);
  const executorReplySnapshot = await waitForBridgeTurn(
    executorPageId,
    "assistant",
    executorToken,
    120_000
  );
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
    target_surface: "ISOLATED_BROWSER_CONTEXT_WITH_AUTH_STATE_COPIED_FROM_DEDICATED_CHROME",
    userscript_transport: "PINNED_UPSTREAM_USERSCRIPT_WITH_PLAYWRIGHT_EXPOSED_GM_BRIDGE_AND_BOUNDED_SEND_SELECTOR_OVERLAY",
    compatibility_overlay_sha256: compatibilityOverlaySha256,
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
    planner_reply_digest: sha(plannerReplySnapshot.lastAssistant || ""),
    executor_reply_digest: sha(executorReplySnapshot.lastAssistant || ""),
    openai_api_required_for_bridge_transport: false,
    production_state_mutated: false,
    production_targets_mutated: false,
    preexisting_pages_closed: false,
    production_browser_process_stopped: false
  });

  log("MBV1_001_STATUS", "PASS");
  log("MBV1_001_PREEXISTING_PAGES_CLOSED", "False");
  log("MBV1_001_PRODUCTION_BROWSER_STOPPED", "False");
} catch (error) {
  await writeResult({
    status: "FAIL",
    error_name: String(error?.name || "Error"),
    error_digest: sha(String(error?.message || error)),
    production_state_mutated: false,
    production_targets_mutated: false,
    preexisting_pages_closed: false,
    production_browser_process_stopped: false
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
  await qualificationContext?.close().catch(() => {});
  // Intentionally do not call browser.close(): this connection targets the
  // already-running dedicated production Chrome. Process exit disconnects CDP
  // without stopping the browser or its default production context.
}
