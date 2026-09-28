import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [root, cdpUrl] = process.argv.slice(2);
if (!root || !cdpUrl) throw new Error("root and cdpUrl are required");
const state = JSON.parse(await fs.readFile(path.join(root, "planner-executor-state.json"), "utf8"));
const adapterPath = path.join(root, "runtime", "src", "ui", "playwright-adapter.mjs");
const { ChatGptUiAdapter } = await import(pathToFileURL(adapterPath).href);

const adapter = new ChatGptUiAdapter({
  cdpUrl,
  settleMs: 800,
  actionTimeoutMs: 10_000,
  timeoutMs: 45_000
});

function emit(role, stage, probe, urlMatches) {
  const s = probe?.snapshot || {};
  const prefix = "SURFACE_" + role.toUpperCase() + "_" + stage;
  const fields = {
    URL_MATCH: urlMatches,
    PATH_KIND: s.pathKind || "",
    CONVERSATION: Boolean(s.conversationPath),
    COMPOSER: Boolean(s.composerReady),
    LOGIN: Boolean(s.loginRequired),
    CAPTCHA: Boolean(s.hasCaptcha),
    MISSING: Boolean(s.conversationMissing),
    DENIED: Boolean(s.conversationAccessDenied),
    NETWORK: Boolean(s.hasNetworkError),
    TRANSIENT: Boolean(s.hasTransientError),
    RUNNING: Boolean(s.responseRunning || s.assistantBusy)
  };
  for (const [k, v] of Object.entries(fields)) {
    console.log(prefix + "_" + k + "=" + v);
  }
}

function sameTarget(actual, expected) {
  try {
    const a = new URL(actual);
    const e = new URL(expected);
    return a.origin === e.origin && a.pathname === e.pathname;
  } catch {
    return false;
  }
}

await adapter.open();
for (const [role, url] of [
  ["planner", state?.planner?.target],
  ["executor", state?.executor?.target]
]) {
  if (!url) throw new Error(role + " target missing");
  const page = await adapter.newChatPage(url);
  try {
    const before = await adapter.probePage(page);
    emit(role, "BEFORE_RELOAD", before, sameTarget(page.url(), url));
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(3000);
    const after = await adapter.probePage(page);
    emit(role, "AFTER_RELOAD", after, sameTarget(page.url(), url));
  } finally {
    await adapter.closePage(page).catch(() => {});
  }
}
await adapter.close();
console.log("SURFACE_PROBE=PASS");
process.exit(0);
