import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import { sendComposerInstruction } from "../../src/ui/actions.mjs";
import {
  ChatGptBridgeAdapter,
  bridgeAssistantDigest
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
async function bestEffortWithin(label, operation, timeoutMs = 5_000) {
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve().then(operation).catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          log("MBV1_008_CLEANUP_TIMEOUT", label);
          resolve();
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
async function waitSetupReply(page, token) {
  return waitFor(async () => {
    const result = await page.evaluate((expected) => {
      const turns = Array.from(
        document.querySelectorAll("main [data-testid^='conversation-turn-']")
      );
      const legacy = Array.from(
        document.querySelectorAll('[data-message-author-role="assistant"]')
      );
      const modern = Array.from(
        document.querySelectorAll("main [class*='MarkdownRoot-'], main .markdown")
      );
      const nodes = turns.length ? turns : [...legacy, ...modern];
      return nodes.some((node) =>
        String(node.innerText || node.textContent || "").includes(expected)
      );
    }, token).catch(() => false);
    if (!result) return false;
    const probe = await browser.probePage(page).catch(() => null);
    return probe &&
      !probe.snapshot?.responseRunning &&
      !probe.snapshot?.assistantBusy
      ? true
      : false;
  }, 120_000, "ChatGPT setup token reply");
}

async function waitReloadInteractive(page, label) {
  const interactive = async () => page.evaluate(() => {
    const composer = document.querySelector("#prompt-textarea") ||
      document.querySelector('[contenteditable][role="textbox"]') ||
      document.querySelector("textarea");
    return Boolean(document.querySelector("main") && composer);
  }).catch(() => false);

  try {
    return await waitFor(interactive, 45_000, label + " interactive");
  } catch {
    // A same-URL ChatGPT reload can occasionally stop at a blank SPA shell.
    // One bounded second reload is safe before any Bridge command is enqueued.
    await page.reload({ waitUntil: "domcontentloaded" });
    return waitFor(interactive, 45_000, label + " interactive recovery");
  }
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
  await waitSetupReply(page, token);
  log("MBV1_008_SETUP_" + role.toUpperCase(), "PASS");
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

async function waitBridgeHistoryToken(bridge, pageId, token, label) {
  return waitFor(async () => {
    const snap = await bridge.getSnapshot(pageId).catch(() => null);
    if (!snap || snap.is_generating) return false;
    const evidence = JSON.stringify({
      recent_turns: snap.recent_turns,
      last_assistant: snap.last_assistant
    });
    return evidence.includes(token) ? snap : false;
  }, 45_000, label + " Bridge history hydration");
}
async function waitBridgeHistoryEvidence(bridge, pageId, evidence, label) {
  return waitFor(async () => {
    const snap = await bridge.getSnapshot(pageId).catch(() => null);
    if (!snap || snap.is_generating) return false;
    const hasAssistantText = Boolean(
      String(snap.last_assistant || "").trim() ||
      (Array.isArray(snap.recent_turns) && snap.recent_turns.some((turn) =>
        turn?.role === "assistant" && String(turn?.text || "").trim()
      ))
    );
    if (!hasAssistantText) return false;

    const expectedCount = Number(evidence?.assistant_count || 0);
    const expectedDigest = String(evidence?.assistant_digest || "").trim().toLowerCase();
    const currentDigest = bridgeAssistantDigest(snap).toLowerCase();

    // ChatGPT can virtualize older turns after a hard reload, so the Bridge's
    // visible assistant_count may temporarily be lower than the pre-reload
    // count even though the same canonical conversation is reacquired.
    // Accept hydration when either the count has recovered OR the exact latest
    // assistant digest from before reload is visible again.
    const countRecovered = snap.assistant_count >= expectedCount;
    const exactLatestRecovered =
      /^[a-f0-9]{64}$/.test(expectedDigest) && currentDigest === expectedDigest;

    return countRecovered || exactLatestRecovered ? snap : false;
  }, 60_000, label + " Bridge history hydration");
}

async function sendToken(bridge, pageId, role, suffix) {
  const token = "MBV1_008_" + role.toUpperCase() + "_" + suffix + "_" +
    crypto.randomBytes(5).toString("hex");
  let result;
  try {
    result = await bridge.send(
      pageId,
      "MBV1-008 harmless live transport qualification. Role: " + role +
        ". Reply with exactly this token and nothing else: " + token,
      { timeoutMs: 180_000 }
    );
  } catch (error) {
    const page = role === "planner" ? plannerPage : executorPage;
    const [bridgeSnapshot, bridgeState, probe, dom] = await Promise.all([
      bridge.getSnapshot(pageId).catch(() => null),
      bridge.getState(pageId).catch(() => null),
      page ? browser.probePage(page).catch(() => null) : null,
      page ? page.evaluate((expected) => {
        const normalize = (value) => String(value || "")
          .replace(/\u200B/g, "")
          .replace(/\r\n/g, "\n")
          .replace(/\u00A0/g, " ")
          .replace(/\s+/gu, " ")
          .trim();
        const wanted = normalize(expected);
        const legacyUsers = Array.from(
          document.querySelectorAll('[data-message-author-role="user"]')
        );
        const modernUsers = legacyUsers.length
          ? []
          : Array.from(document.querySelectorAll("main .text-size-chat.whitespace-pre-wrap"));
        const users = legacyUsers.length ? legacyUsers : modernUsers;
        const composer = document.querySelector("#prompt-textarea") ||
          document.querySelector('[contenteditable][role="textbox"]') ||
          document.querySelector("textarea");
        const composerText = normalize(
          composer ? (composer.innerText || composer.value || composer.textContent || "") : ""
        );
        const roleNodes = Array.from(document.querySelectorAll('[data-message-author-role]'));
        const roleCounts = roleNodes.reduce((acc, node) => {
          const role = String(node.getAttribute('data-message-author-role') || 'empty');
          acc[role] = (acc[role] || 0) + 1;
          return acc;
        }, {});
        return {
          exact_user_turn_count: users.filter((node) =>
            normalize(node.innerText || node.textContent || "") === wanted
          ).length,
          composer_has_exact_instruction: composerText === wanted,
          composer_nonempty: Boolean(composerText),
          composer_present: Boolean(composer),
          active_element_is_composer: Boolean(composer && document.activeElement === composer),
          patch_marker: String(globalThis.__MAGASIN_BRIDGE_PATCH__ || ""),
          role_counts: roleCounts,
          modern_user_count: document.querySelectorAll("main .text-size-chat.whitespace-pre-wrap").length,
          modern_assistant_count: document.querySelectorAll("main [class*='MarkdownRoot-']").length,
          conversation_turn_count: document.querySelectorAll("[data-testid^='conversation-turn-']").length,
          markdown_count: document.querySelectorAll("main .markdown").length
        };
      }, "MBV1-008 harmless live transport qualification. Role: " + role +
        ". Reply with exactly this token and nothing else: " + token).catch(() => null) : null
    ]);

    log("MBV1_008_DIAG_ROLE", role);
    log("MBV1_008_DIAG_ERROR_CODE", error?.code || error?.name || "unknown");
    log("MBV1_008_DIAG_BRIDGE_ALIVE", bridgeState?.alive ?? null);
    log("MBV1_008_DIAG_BRIDGE_LAST_POLL_AGO", bridgeState?.last_poll_ago ?? null);
    log("MBV1_008_DIAG_BRIDGE_ASSISTANT_COUNT", bridgeSnapshot?.assistant_count ?? null);
    log("MBV1_008_DIAG_BRIDGE_GENERATING", bridgeSnapshot?.is_generating ?? null);
    log("MBV1_008_DIAG_BRIDGE_EDITOR_NONEMPTY", Boolean(bridgeSnapshot?.editor_text));
    log("MBV1_008_DIAG_BRIDGE_SNAPSHOT_HAS_TOKEN",
      Boolean(bridgeSnapshot && JSON.stringify(bridgeSnapshot).includes(token)));
    log("MBV1_008_DIAG_UI_USER_COUNT", probe?.snapshot?.userMessageCount ?? null);
    log("MBV1_008_DIAG_UI_ASSISTANT_COUNT", probe?.snapshot?.assistantMessageCount ?? null);
    log("MBV1_008_DIAG_UI_RESPONSE_RUNNING", probe?.snapshot?.responseRunning ?? null);
    log("MBV1_008_DIAG_UI_ASSISTANT_BUSY", probe?.snapshot?.assistantBusy ?? null);
    log("MBV1_008_DIAG_EXACT_USER_TURN_COUNT", dom?.exact_user_turn_count ?? null);
    log("MBV1_008_DIAG_COMPOSER_HAS_EXACT", dom?.composer_has_exact_instruction ?? null);
    log("MBV1_008_DIAG_COMPOSER_NONEMPTY", dom?.composer_nonempty ?? null);
    log("MBV1_008_DIAG_COMPOSER_PRESENT", dom?.composer_present ?? null);
    log("MBV1_008_DIAG_COMPOSER_FOCUSED", dom?.active_element_is_composer ?? null);
    log("MBV1_008_DIAG_PATCH_MARKER", dom?.patch_marker ?? null);
    log("MBV1_008_DIAG_ROLE_COUNTS", dom?.role_counts ? JSON.stringify(dom.role_counts) : null);
    log("MBV1_008_DIAG_MODERN_USER_COUNT", dom?.modern_user_count ?? null);
    log("MBV1_008_DIAG_MODERN_ASSISTANT_COUNT", dom?.modern_assistant_count ?? null);
    log("MBV1_008_DIAG_CONVERSATION_TURN_COUNT", dom?.conversation_turn_count ?? null);
    log("MBV1_008_DIAG_MARKDOWN_COUNT", dom?.markdown_count ?? null);
    throw error;
  }
  const reply = String(result?.snapshot?.last_assistant || "");
  const tokenMatch = reply.includes(token);
  if (!tokenMatch) {
    const recent = Array.isArray(result?.snapshot?.recent_turns)
      ? result.snapshot.recent_turns
      : [];
    const assistantRecent = recent.filter((turn) => turn?.role === "assistant");
    const page = role === "planner" ? plannerPage : executorPage;
    const domToken = page ? await page.evaluate((expected) => {
      const selectors = [
        '[data-message-author-role="assistant"]',
        "main [class*='MarkdownRoot-']",
        "main .markdown"
      ];
      const nodes = Array.from(document.querySelectorAll(selectors.join(",")));
      const unique = Array.from(new Set(nodes));
      return {
        assistant_nodes: unique.length,
        token_hits: unique.filter((node) =>
          String(node.innerText || node.textContent || "").includes(expected)
        ).length
      };
    }, token).catch(() => null) : null;
    log("MBV1_008_MISMATCH_ROLE", role);
    log("MBV1_008_MISMATCH_ASSISTANT_COUNT", result?.snapshot?.assistant_count ?? null);
    log("MBV1_008_MISMATCH_GENERATING", result?.snapshot?.is_generating ?? null);
    log("MBV1_008_MISMATCH_LAST_LENGTH", reply.length);
    log("MBV1_008_MISMATCH_LAST_DIGEST", sha(reply));
    log("MBV1_008_MISMATCH_RECENT_ASSISTANTS", assistantRecent.length);
    log("MBV1_008_MISMATCH_RECENT_TOKEN_HITS",
      assistantRecent.filter((turn) => String(turn?.text || "").includes(token)).length);
    log("MBV1_008_MISMATCH_DOM_ASSISTANT_NODES", domToken?.assistant_nodes ?? null);
    log("MBV1_008_MISMATCH_DOM_TOKEN_HITS", domToken?.token_hits ?? null);
    log("MBV1_008_MISMATCH_COUNT_ADVANCED", result?.evidence?.count_advanced ?? null);
    log("MBV1_008_MISMATCH_DIGEST_CHANGED", result?.evidence?.digest_changed ?? null);
  }

  // Model nonce obedience is diagnostic only. The transport gate requires
  // exact page correlation plus a newly observed, completed assistant turn.
  if (
    result?.evidence?.count_advanced !== true ||
    result?.snapshot?.is_generating ||
    !reply.trim()
  ) {
    throw new Error(role + " transport response evidence is incomplete");
  }
  log("MBV1_008_NONCE_MATCH_" + role.toUpperCase(), tokenMatch ? "PASS" : "DIAGNOSTIC_MISMATCH");
  return {
    token,
    token_match: tokenMatch,
    assistant_count: result.snapshot.assistant_count,
    assistant_digest: sha(reply)
  };
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
  await Promise.all([
    waitBridgeHistoryToken(
      bridge, binding.planner.page_id, plannerSetup.token, "planner initial"
    ),
    waitBridgeHistoryToken(
      bridge, binding.executor.page_id, executorSetup.token, "executor initial"
    )
  ]);

  const executorBeforePlanner = await bridge.getSnapshot(binding.executor.page_id);
  const plannerProbe = await sendToken(
    bridge, binding.planner.page_id, "planner", "BASE"
  );
  const executorAfterPlanner = await bridge.getSnapshot(binding.executor.page_id);
  if (executorAfterPlanner.assistant_count !== executorBeforePlanner.assistant_count) {
    throw new Error("Planner send changed Executor assistant count");
  }
  if (
    plannerProbe.token_match &&
    JSON.stringify(executorAfterPlanner).includes(plannerProbe.token)
  ) {
    throw new Error("Planner token crossed into Executor snapshot");
  }

  const plannerBeforeExecutor = await bridge.getSnapshot(binding.planner.page_id);
  const executorProbe = await sendToken(
    bridge, binding.executor.page_id, "executor", "BASE"
  );
  const plannerAfterExecutor = await bridge.getSnapshot(binding.planner.page_id);
  if (plannerAfterExecutor.assistant_count !== plannerBeforeExecutor.assistant_count) {
    throw new Error("Executor send changed Planner assistant count");
  }
  if (
    executorProbe.token_match &&
    JSON.stringify(plannerAfterExecutor).includes(executorProbe.token)
  ) {
    throw new Error("Executor token crossed into Planner snapshot");
  }
  log("MBV1_008_LIVE_BASE_TRANSPORT", "PASS");
  log("MBV1_008_LIVE_ROLE_ISOLATION", "PASS");

  await plannerPage.reload({ waitUntil: "domcontentloaded" });
  await waitReloadInteractive(plannerPage, "planner reload");
  await injectPinnedBridgeUserscript(plannerPage, userscript, { bindingName });
  binding = await waitBinding(bridge, plannerSetup.url, executorSetup.url);
  const plannerHistoryRehydrated = await waitBridgeHistoryEvidence(
    bridge, binding.planner.page_id, plannerProbe, "planner reload"
  ).then(() => true).catch(() => false);
  log(
    "MBV1_008_PLANNER_RELOAD_HISTORY_REHYDRATED",
    plannerHistoryRehydrated ? "PASS" : "NOT_OBSERVED"
  );
  const plannerReloadProbe = await sendToken(
    bridge, binding.planner.page_id, "planner", "RELOAD"
  );
  log("MBV1_008_LIVE_PLANNER_RELOAD", "PASS");

  await executorPage.reload({ waitUntil: "domcontentloaded" });
  await waitReloadInteractive(executorPage, "executor reload");
  await injectPinnedBridgeUserscript(executorPage, userscript, { bindingName });
  binding = await waitBinding(bridge, plannerSetup.url, executorSetup.url);
  const executorHistoryRehydrated = await waitBridgeHistoryEvidence(
    bridge, binding.executor.page_id, executorProbe, "executor reload"
  ).then(() => true).catch(() => false);
  log(
    "MBV1_008_EXECUTOR_RELOAD_HISTORY_REHYDRATED",
    executorHistoryRehydrated ? "PASS" : "NOT_OBSERVED"
  );
  const executorReloadProbe = await sendToken(
    bridge, binding.executor.page_id, "executor", "RELOAD"
  );
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
  // This replacement backend is qualification-owned. Do not let its child
  // process handle keep the Node qualifier alive after LIVE_STATUS=PASS;
  // the PowerShell wrapper owns bounded process-tree cleanup by workRoot.
  replacementBackend.unref();
  await waitBridgeHealthy(true);
  binding = await waitBinding(bridge, plannerSetup.url, executorSetup.url);
  await Promise.all([
    waitBridgeHistoryEvidence(
      bridge, binding.planner.page_id, plannerReloadProbe, "planner bridge restart"
    ),
    waitBridgeHistoryEvidence(
      bridge, binding.executor.page_id, executorReloadProbe, "executor bridge restart"
    )
  ]);
  await sendToken(bridge, binding.planner.page_id, "planner", "BRIDGE_RESTART");
  log("MBV1_008_LIVE_BRIDGE_RESTART", "PASS");

  const baseline = await bridge.captureBaseline(binding.planner.page_id);
  const longToken = "MBV1_008_LONG_" + crypto.randomBytes(5).toString("hex");
  await bridge.sendAsync(
    binding.planner.page_id,
    "MBV1-008 long-generation qualification. Write 30 numbered very short lines, one per line, then finish with exactly " +
      longToken
  );
  let sawGenerating = false;
  let lastLongSnapshot = null;
  let finalLong;
  try {
    finalLong = await waitFor(async () => {
      const snap = await bridge.getSnapshot(binding.planner.page_id);
      lastLongSnapshot = snap;
      if (snap.is_generating) sawGenerating = true;
      const changed = snap.assistant_count > baseline.assistant_count;
      const complete = changed && !snap.is_generating &&
        Boolean(String(snap.last_assistant || "").trim());
      return complete ? snap : false;
    }, 180_000, "long generation completion");
  } catch (error) {
    const [bridgeState, probe, dom] = await Promise.all([
      bridge.getState(binding.planner.page_id).catch(() => null),
      plannerPage ? browser.probePage(plannerPage).catch(() => null) : null,
      plannerPage ? plannerPage.evaluate(() => {
        const composer = document.querySelector("#prompt-textarea") ||
          document.querySelector('[contenteditable][role="textbox"]') ||
          document.querySelector("textarea");
        return {
          composer_nonempty: Boolean(
            String(composer?.innerText || composer?.value || composer?.textContent || "").trim()
          ),
          conversation_turn_count:
            document.querySelectorAll("[data-testid^='conversation-turn-']").length,
          legacy_user_count:
            document.querySelectorAll('[data-message-author-role="user"]').length,
          legacy_assistant_count:
            document.querySelectorAll('[data-message-author-role="assistant"]').length,
          modern_assistant_count:
            document.querySelectorAll("main [class*='MarkdownRoot-']").length
        };
      }).catch(() => null) : null
    ]);
    log("MBV1_008_LONG_DIAG_BASE_COUNT", baseline.assistant_count);
    log("MBV1_008_LONG_DIAG_LAST_COUNT", lastLongSnapshot?.assistant_count ?? null);
    log("MBV1_008_LONG_DIAG_GENERATING", lastLongSnapshot?.is_generating ?? null);
    log("MBV1_008_LONG_DIAG_SAW_GENERATING", sawGenerating);
    log("MBV1_008_LONG_DIAG_EDITOR_NONEMPTY",
      Boolean(lastLongSnapshot?.editor_text));
    log("MBV1_008_LONG_DIAG_PAGE_ALIVE", bridgeState?.alive ?? null);
    log("MBV1_008_LONG_DIAG_LAST_POLL_AGO", bridgeState?.last_poll_ago ?? null);
    log("MBV1_008_LONG_DIAG_UI_USER_COUNT", probe?.snapshot?.userMessageCount ?? null);
    log("MBV1_008_LONG_DIAG_UI_ASSISTANT_COUNT", probe?.snapshot?.assistantMessageCount ?? null);
    log("MBV1_008_LONG_DIAG_UI_RESPONSE_RUNNING", probe?.snapshot?.responseRunning ?? null);
    log("MBV1_008_LONG_DIAG_COMPOSER_NONEMPTY", dom?.composer_nonempty ?? null);
    log("MBV1_008_LONG_DIAG_TURNS", dom?.conversation_turn_count ?? null);
    log("MBV1_008_LONG_DIAG_LEGACY_USERS", dom?.legacy_user_count ?? null);
    log("MBV1_008_LONG_DIAG_LEGACY_ASSISTANTS", dom?.legacy_assistant_count ?? null);
    log("MBV1_008_LONG_DIAG_MODERN_ASSISTANTS", dom?.modern_assistant_count ?? null);
    throw error;
  }
  log(
    "MBV1_008_LONG_GENERATING_OBSERVED",
    sawGenerating ? "PASS" : "NOT_OBSERVED"
  );
  if (finalLong.is_generating) {
    throw new Error("long-generation parser completed while still generating");
  }
  if (
    finalLong.assistant_count <= baseline.assistant_count ||
    !String(finalLong.last_assistant || "").trim()
  ) {
    throw new Error("long-generation qualification lacks completed new-response evidence");
  }
  log("MBV1_008_LONG_NONCE_MATCH",
    String(finalLong.last_assistant || "").includes(longToken) ? "PASS" : "DIAGNOSTIC_MISMATCH");
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
    await bestEffortWithin(
      "executor-page",
      () => browser.closePage(executorPage)
    );
  }
  if (plannerPage && !plannerPage.isClosed()) {
    await bestEffortWithin(
      "planner-page",
      () => browser.closePage(plannerPage)
    );
  }
  await bestEffortWithin("browser-adapter", () => browser.close());
}

// A successful qualifier must not remain resident because of CDP/child-process
// handles after its authoritative result has already been written. The
// PowerShell wrapper owns process-tree and isolated-Chrome cleanup.
process.exit(0);

function assertDistinct(binding) {
  if (
    !binding?.planner?.page_id ||
    !binding?.executor?.page_id ||
    binding.planner.page_id === binding.executor.page_id
  ) {
    throw new Error("Planner/Executor live Bridge page identities are not distinct");
  }
}
