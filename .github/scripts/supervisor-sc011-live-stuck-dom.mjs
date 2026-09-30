import { pathToFileURL } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const [runtimeRoot, cdpUrl] = process.argv.slice(2);
if (!runtimeRoot || !cdpUrl) throw new Error("runtimeRoot and cdpUrl required");

const adapterUrl = pathToFileURL(path.join(runtimeRoot, "src", "ui", "playwright-adapter.mjs")).href;
const { ChatGptUiAdapter } = await import(adapterUrl);

const digest = (value) => crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
const adapter = new ChatGptUiAdapter({
  cdpUrl,
  settleMs: 0,
  actionTimeoutMs: 5000,
  timeoutMs: 15000
});

try {
  await adapter.open();
  const pages = adapter.getChatGptPages();
  console.log("LIVE_STUCK_CHAT_PAGE_COUNT=" + pages.length);
  let i = 0;
  for (const page of pages) {
    i += 1;
    const probe = await adapter.probePage(page).catch(() => null);
    const dom = await page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
      };
      const composer = [
        document.querySelector("#prompt-textarea"),
        ...document.querySelectorAll("textarea,[contenteditable='true']")
      ].find(visible) || null;
      const composerText = composer
        ? String(("value" in composer ? composer.value : "") || composer.innerText || composer.textContent || "")
        : "";
      const buttons = [...document.querySelectorAll("button,[role='button']")].filter(visible);
      const send = buttons.find((el) => {
        const testid = String(el.getAttribute("data-testid") || "").toLowerCase();
        const aria = String(el.getAttribute("aria-label") || "").trim();
        const text = String(el.innerText || el.textContent || "").trim();
        return testid === "send-button" || /^(send|send prompt|gửi|gửi tin nhắn)$/i.test(aria) || /^(send|gửi)$/i.test(text);
      }) || null;
      const stop = buttons.find((el) => {
        const testid = String(el.getAttribute("data-testid") || "").toLowerCase();
        const aria = String(el.getAttribute("aria-label") || "").trim();
        return testid === "stop-button" || /stop generating|stop response|dừng tạo|dừng phản hồi/i.test(aria);
      }) || null;
      const info = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const center = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
        return {
          tag: el.tagName,
          testid: el.getAttribute("data-testid"),
          aria: el.getAttribute("aria-label"),
          title: el.getAttribute("title"),
          disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true",
          visible: visible(el),
          pointerEvents: getComputedStyle(el).pointerEvents,
          centerTag: center?.tagName || null,
          centerTestid: center?.getAttribute?.("data-testid") || null,
          centerAria: center?.getAttribute?.("aria-label") || null
        };
      };
      const active = document.activeElement;
      const turns = [...document.querySelectorAll("[data-message-author-role]")].map(el => ({
        role: el.getAttribute("data-message-author-role"),
        len: String(el.innerText || el.textContent || "").length
      }));
      return {
        url: location.href,
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        composerPresent: Boolean(composer),
        composerEnabled: Boolean(composer && !composer.disabled && composer.getAttribute("aria-disabled") !== "true" && composer.getAttribute("contenteditable") !== "false"),
        composerText,
        composerHtmlLength: composer ? String(composer.innerHTML || "").length : 0,
        composerAriaDisabled: composer?.getAttribute("aria-disabled") || null,
        composerContentEditable: composer?.getAttribute("contenteditable") || null,
        send: info(send),
        stop: info(stop),
        activeTag: active?.tagName || null,
        activeId: active?.id || null,
        activeTestid: active?.getAttribute?.("data-testid") || null,
        activeContentEditable: active?.getAttribute?.("contenteditable") || null,
        userTurns: turns.filter(x => x.role === "user").length,
        assistantTurns: turns.filter(x => x.role === "assistant").length,
        latestTurnRole: turns.at(-1)?.role || null,
        latestTurnLength: turns.at(-1)?.len || 0
      };
    });
    const safeUrl = (() => { try { const u = new URL(dom.url); return u.origin + u.pathname; } catch { return ""; } })();
    console.log("LIVE_STUCK_PAGE_" + i + "_URL=" + safeUrl);
    console.log("LIVE_STUCK_PAGE_" + i + "_VISIBLE=" + (dom.visibility === "visible"));
    console.log("LIVE_STUCK_PAGE_" + i + "_FOCUSED=" + dom.hasFocus);
    console.log("LIVE_STUCK_PAGE_" + i + "_COMPOSER_PRESENT=" + dom.composerPresent);
    console.log("LIVE_STUCK_PAGE_" + i + "_COMPOSER_ENABLED=" + dom.composerEnabled);
    console.log("LIVE_STUCK_PAGE_" + i + "_COMPOSER_TEXT_LEN=" + dom.composerText.length);
    console.log("LIVE_STUCK_PAGE_" + i + "_COMPOSER_TEXT_DIGEST=" + digest(dom.composerText));
    console.log("LIVE_STUCK_PAGE_" + i + "_COMPOSER_HTML_LEN=" + dom.composerHtmlLength);
    console.log("LIVE_STUCK_PAGE_" + i + "_SEND_PRESENT=" + Boolean(dom.send));
    console.log("LIVE_STUCK_PAGE_" + i + "_SEND_DISABLED=" + Boolean(dom.send?.disabled));
    console.log("LIVE_STUCK_PAGE_" + i + "_SEND_TESTID=" + String(dom.send?.testid || ""));
    console.log("LIVE_STUCK_PAGE_" + i + "_SEND_ARIA=" + String(dom.send?.aria || ""));
    console.log("LIVE_STUCK_PAGE_" + i + "_SEND_POINTER_EVENTS=" + String(dom.send?.pointerEvents || ""));
    console.log("LIVE_STUCK_PAGE_" + i + "_SEND_CENTER_TAG=" + String(dom.send?.centerTag || ""));
    console.log("LIVE_STUCK_PAGE_" + i + "_SEND_CENTER_TESTID=" + String(dom.send?.centerTestid || ""));
    console.log("LIVE_STUCK_PAGE_" + i + "_SEND_CENTER_ARIA=" + String(dom.send?.centerAria || ""));
    console.log("LIVE_STUCK_PAGE_" + i + "_STOP_PRESENT=" + Boolean(dom.stop));
    console.log("LIVE_STUCK_PAGE_" + i + "_ACTIVE_TAG=" + String(dom.activeTag || ""));
    console.log("LIVE_STUCK_PAGE_" + i + "_ACTIVE_ID=" + String(dom.activeId || ""));
    console.log("LIVE_STUCK_PAGE_" + i + "_USER_TURNS=" + dom.userTurns);
    console.log("LIVE_STUCK_PAGE_" + i + "_ASSISTANT_TURNS=" + dom.assistantTurns);
    console.log("LIVE_STUCK_PAGE_" + i + "_LATEST_TURN_ROLE=" + String(dom.latestTurnRole || ""));
    console.log("LIVE_STUCK_PAGE_" + i + "_LATEST_TURN_LEN=" + dom.latestTurnLength);
    if (probe) {
      console.log("LIVE_STUCK_PAGE_" + i + "_CLASS_UI=" + String(probe.classification?.uiState || ""));
      console.log("LIVE_STUCK_PAGE_" + i + "_CLASS_OBSERVATION=" + String(probe.classification?.observation || ""));
      console.log("LIVE_STUCK_PAGE_" + i + "_SNAPSHOT_COMPOSER_READY=" + Boolean(probe.snapshot?.composerReady));
      console.log("LIVE_STUCK_PAGE_" + i + "_SNAPSHOT_RESPONSE_RUNNING=" + Boolean(probe.snapshot?.responseRunning));
      console.log("LIVE_STUCK_PAGE_" + i + "_SNAPSHOT_GENERIC_BLOCKED=" + Boolean(probe.snapshot?.composerGenericBlocked));
    }
  }
} finally {
  await adapter.close().catch(() => {});
}
