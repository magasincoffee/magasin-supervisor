import fs from "node:fs";
import path from "node:path";

import { classifyUiSnapshot } from "./classifier.mjs";
import { collectSafeUiSnapshot } from "./snapshot.mjs";
import { pageMatchesTarget, targetFromUrl } from "../runtime/recovery.mjs";

export function defaultSupervisorProfileDir(env = process.env) {
  const base = env.LOCALAPPDATA || env.HOME || process.cwd();
  return path.join(base, "MAGASIN", "BusinessOS", "supervisor", "browser_profile");
}

export function resolveChromeExecutable(env = process.env) {
  const explicit = env.MAGASIN_SUPERVISOR_CHROME;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const candidates = [
    env.ProgramFiles && path.join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

export function isChatGptUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com"));
  } catch {
    return false;
  }
}

export function isTransientNavigationError(error) {
  const message = String(error?.message || error || "");
  return /execution context was destroyed|most likely because of a navigation|target page, context or browser has been closed|navigation|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|network.*(?:failed|reset|changed)|CDP version endpoint failed|websocket.*closed|connectOverCDP/i.test(message);
}

export function normalizeCdpWebSocketUrl(value, cdpUrl) {
  const websocket = new URL(value);
  const endpoint = new URL(cdpUrl);
  if (["localhost", "127.0.0.1", "::1"].includes(websocket.hostname)) {
    websocket.hostname = endpoint.hostname;
  }
  if (endpoint.port) websocket.port = endpoint.port;
  return websocket.toString();
}

export async function resolveCdpEndpoint(cdpUrl, fetchImpl = fetch) {
  const base = String(cdpUrl || "").replace(/\/+$/, "");
  const response = await fetchImpl(`${base}/json/version`, {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`CDP version endpoint failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload?.webSocketDebuggerUrl) {
    throw new Error("CDP version endpoint missing webSocketDebuggerUrl");
  }
  return normalizeCdpWebSocketUrl(payload.webSocketDebuggerUrl, base);
}

export class ChatGptUiAdapter {
  constructor({
    profileDir = defaultSupervisorProfileDir(),
    chromeExecutable = resolveChromeExecutable(),
    url = "https://chatgpt.com/",
    headless = false,
    timeoutMs = 60_000,
    actionTimeoutMs = 10_000,
    settleMs = 2_500,
    cdpUrl = null
  } = {}) {
    this.profileDir = profileDir;
    this.chromeExecutable = chromeExecutable;
    this.url = url;
    this.headless = headless;
    this.timeoutMs = timeoutMs;
    this.actionTimeoutMs = actionTimeoutMs;
    this.settleMs = settleMs;
    this.cdpUrl = cdpUrl;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.attachedOverCdp = false;
    this.targetRecoveryPages = new Map();
    this.recentNavigationHydratedPages = new WeakSet();
  }

  async reconnectOverCdp() {
    if (!this.cdpUrl) throw new Error("CDP reconnect requires cdpUrl");

    const { chromium } = await import("playwright-core");
    const resolvedCdpEndpoint = await resolveCdpEndpoint(this.cdpUrl);
    this.browser = await chromium.connectOverCDP(resolvedCdpEndpoint);
    this.attachedOverCdp = true;
    this.context = this.browser.contexts()[0] || null;
    if (!this.context) {
      throw new Error("real Chrome CDP connection has no browser context");
    }
    this.context.setDefaultTimeout(this.actionTimeoutMs);
    this.context.setDefaultNavigationTimeout(this.timeoutMs);
    this.page = this.getActivePage();
    if (!this.page) {
      throw new Error("real Chrome CDP connection has no open page");
    }
    this.targetRecoveryPages.clear();
    return this.page;
  }

  async open() {
    const { chromium } = await import("playwright-core");

    if (this.cdpUrl) {
      await this.reconnectOverCdp();
      await this.page.waitForTimeout(this.settleMs);
      return this.page;
    }

    if (!this.chromeExecutable) {
      throw new Error("Google Chrome executable was not found");
    }

    fs.mkdirSync(this.profileDir, { recursive: true });

    this.context = await chromium.launchPersistentContext(this.profileDir, {
      executablePath: this.chromeExecutable,
      headless: this.headless,
      acceptDownloads: false,
      viewport: { width: 1440, height: 1000 }
    });

    this.context.setDefaultTimeout(this.actionTimeoutMs);
    this.context.setDefaultNavigationTimeout(this.timeoutMs);
    this.page = this.context.pages()[0] || await this.context.newPage();
    await this.page.goto(this.url, {
      waitUntil: "domcontentloaded",
      timeout: this.timeoutMs
    });
    await this.page.waitForTimeout(this.settleMs);
    return this.page;
  }

  getActivePage() {
    if (!this.context) return null;

    // Once the Supervisor has attached to a page, keep that page sticky.
    // Real Chrome may contain multiple ChatGPT tabs. Re-selecting the last
    // ChatGPT tab on every probe can make the robot jump away from the chat it
    // just created, then navigate back to an obsolete target forever.
    if (
      this.page &&
      !this.page.isClosed() &&
      isChatGptUrl(this.page.url())
    ) {
      return this.page;
    }

    const pages = this.context.pages().filter((page) => !page.isClosed());
    if (!pages.length) {
      this.page = null;
      return null;
    }

    const chatGptPages = pages.filter((page) => isChatGptUrl(page.url()));
    this.page = chatGptPages.at(-1) || pages.at(-1);
    return this.page;
  }

  setActivePage(page) {
    if (!page || page.isClosed?.() || !isChatGptUrl(page.url?.() || "")) {
      throw new Error("active page must be an open ChatGPT page");
    }
    this.page = page;
    return page;
  }

  getChatGptPages() {
    if (!this.context) return [];
    return this.context
      .pages()
      .filter((page) => !page.isClosed() && isChatGptUrl(page.url()));
  }

  getChatGptPageCount() {
    return this.getChatGptPages().length;
  }

  async hasNonPersistedComposerArtifact(page) {
    if (!page || page.isClosed()) return false;
    return page.evaluate(() => {
      const editable = document.querySelector(
        '#prompt-textarea, div[contenteditable="true"][data-lexical-editor="true"], textarea'
      );
      const draft = editable
        ? String(editable.innerText || editable.textContent || editable.value || "").trim()
        : "";
      const fileInputs = [...document.querySelectorAll('input[type="file"]')];
      const hasAttachedFile = fileInputs.some((input) =>
        input.files && input.files.length > 0
      );
      return Boolean(draft || hasAttachedFile);
    }).catch(() => true);
  }

  async closePage(page) {
    if (!page || page.isClosed()) return false;
    if (this.page === page) this.page = null;
    await page.close();
    if (!this.page || this.page.isClosed()) {
      this.page = this.getActivePage();
    }
    return true;
  }

  async invalidateTargetRecoveryPage(url, {
    page = null,
    close = false
  } = {}) {
    let key = null;
    try {
      const parsed = new URL(String(url || ""));
      key = `${parsed.origin}${parsed.pathname}`;
    } catch {
      return false;
    }

    const cached = this.targetRecoveryPages.get(key) || null;
    this.targetRecoveryPages.delete(key);
    if (page) {
      for (const [candidateKey, candidatePage] of this.targetRecoveryPages) {
        if (candidatePage === page) {
          this.targetRecoveryPages.delete(candidateKey);
        }
      }
    }

    const targetPage = page || cached;
    if (close && targetPage && !targetPage.isClosed()) {
      const guarded = await this.hasNonPersistedComposerArtifact(targetPage)
        .catch(() => true);
      if (!guarded) {
        await this.closePage(targetPage);
      }
    }
    return true;
  }

  async getVisibleChatGptPages() {
    const visible = [];
    for (const page of this.getChatGptPages()) {
      const isVisible = await page.evaluate(() => document.visibilityState === "visible")
        .catch(() => false);
      if (isVisible) visible.push(page);
    }
    return visible;
  }

  async getFocusedChatGptPages() {
    const focused = [];
    for (const page of this.getChatGptPages()) {
      const hasFocus = await page.evaluate(() => document.hasFocus())
        .catch(() => false);
      if (hasFocus) focused.push(page);
    }
    return focused;
  }

  async revealRecentConversationNavigation(page) {
    if (!page || page.isClosed()) return false;
    if (this.recentNavigationHydratedPages.has(page)) return false;

    const selectors = [
      'button[aria-label="Open sidebar"]',
      '[role="button"][aria-label="Open sidebar"]',
      'button[aria-label*="sidebar" i]',
      '[role="button"][aria-label*="sidebar" i]',
      'button[title*="sidebar" i]',
      '[role="button"][title*="sidebar" i]',
      'button[aria-label*="thanh bên" i]',
      '[role="button"][aria-label*="thanh bên" i]',
      'button[title*="thanh bên" i]',
      '[role="button"][title*="thanh bên" i]'
    ];

    let clicked = false;
    if (typeof page.locator === "function") {
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        const count = await locator.count().catch(() => 0);
        if (count < 1) continue;
        clicked = await locator.click({
          timeout: Math.max(500, Math.min(2_000, Number(this.actionTimeoutMs) || 1_500)),
          force: true
        }).then(() => true).catch(() => false);
        if (clicked) break;
      }
    }

    if (!clicked) {
      clicked = await page.evaluate(() => {
        const controls = [...document.querySelectorAll('button,[role="button"]')];
        const wanted = /(sidebar|side bar|navigation|chat history|recent chats?|thanh bên|thanh điều hướng|lịch sử trò chuyện)/i;
        const reject = /(new chat|new conversation|temporary chat|settings|profile|account|share|voice|attach|upload|send|trò chuyện mới|cài đặt|tài khoản|gửi)/i;
        const candidate = controls.find((node) => {
          const descriptor = [
            node.getAttribute("aria-label"),
            node.getAttribute("title"),
            node.getAttribute("data-testid"),
            node.textContent
          ].filter(Boolean).join(" ").trim();
          return descriptor && wanted.test(descriptor) && !reject.test(descriptor);
        });
        if (!candidate) return false;
        candidate.click();
        return true;
      }).catch(() => false);
    }

    if (!clicked) return false;
    this.recentNavigationHydratedPages.add(page);

    if (typeof page.waitForSelector === "function") {
      await page.waitForSelector(
        '#history a[href], a[href^="/c/"], a[href^="/g/"], a[href^="/project/"]',
        {
          state: "attached",
          timeout: Math.max(500, Math.min(4_000, Number(this.actionTimeoutMs) || 3_000))
        }
      ).catch(() => {});
    } else {
      await page.waitForTimeout(
        Math.max(100, Math.min(1_000, Number(this.settleMs) || 250))
      ).catch(() => {});
    }
    return true;
  }

  async listRecentConversationUrls(page, { limit = 20 } = {}) {
    if (!page || page.isClosed()) return [];
    const maxItems = Math.max(1, Math.min(50, Number(limit) || 20));
    const collect = () => page.evaluate((boundedMaxItems) => {
      const seen = new Set();
      const out = [];
      for (const anchor of document.querySelectorAll("a[href]")) {
        const raw = String(anchor.getAttribute("href") || "").trim();
        if (!raw) continue;
        let url = null;
        try {
          url = new URL(raw, location.origin);
        } catch {
          continue;
        }
        if (url.origin !== "https://chatgpt.com") continue;
        if (!/^\/(c|g|project)\//.test(url.pathname)) continue;
        const normalized = url.origin + url.pathname;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
        if (out.length >= boundedMaxItems) break;
      }
      return out;
    }, maxItems);

    let urls = await collect().catch(() => []);
    if (!Array.isArray(urls)) urls = [];
    if (!urls.length) {
      const revealed = await this.revealRecentConversationNavigation(page)
        .catch(() => false);
      if (revealed) {
        urls = await collect().catch(() => []);
      }
    }
    return Array.isArray(urls) ? urls : [];
  }

  async listBrowserHistoryChatGptUrls({ limit = 100 } = {}) {
    if (!this.context || typeof this.context.newPage !== "function") return [];

    const maxItems = Math.max(1, Math.min(500, Number(limit) || 100));
    let historyPage = null;
    try {
      historyPage = await this.context.newPage();
      await historyPage.goto("chrome://history/?q=chatgpt.com", {
        waitUntil: "commit",
        timeout: Math.max(1_000, Math.min(10_000, Number(this.timeoutMs) || 5_000))
      });
      if (typeof historyPage.waitForTimeout === "function") {
        await historyPage.waitForTimeout(
          Math.max(250, Math.min(1_500, Number(this.settleMs) || 500))
        );
      }

      const urls = await historyPage.evaluate((boundedMaxItems) => {
        const seen = new Set();
        const out = [];
        const roots = [document];
        const visited = new Set();

        while (roots.length && out.length < boundedMaxItems) {
          const root = roots.shift();
          if (!root || visited.has(root)) continue;
          visited.add(root);

          const anchors = typeof root.querySelectorAll === "function"
            ? [...root.querySelectorAll("a[href]")]
            : [];
          for (const anchor of anchors) {
            const raw = String(anchor.getAttribute("href") || "").trim();
            if (!raw) continue;
            let url = null;
            try {
              url = new URL(raw, "https://chatgpt.com/");
            } catch {
              continue;
            }
            if (url.hostname !== "chatgpt.com" && !url.hostname.endsWith(".chatgpt.com")) {
              continue;
            }
            if (!/^\/(c|g|project)\//.test(url.pathname)) continue;
            const normalized = url.origin + url.pathname;
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            out.push(normalized);
            if (out.length >= boundedMaxItems) break;
          }

          const nodes = typeof root.querySelectorAll === "function"
            ? [...root.querySelectorAll("*")]
            : [];
          for (const node of nodes) {
            if (node && node.shadowRoot && !visited.has(node.shadowRoot)) {
              roots.push(node.shadowRoot);
            }
          }
        }

        return out;
      }, maxItems).catch(() => []);

      return Array.isArray(urls) ? urls : [];
    } catch {
      return [];
    } finally {
      if (historyPage && !historyPage.isClosed?.()) {
        await historyPage.close().catch(() => {});
      }
    }
  }

  findPageForTarget(target) {
    if (!target?.origin || !target?.pathname) return null;
    return this.getChatGptPages().find((page) =>
      pageMatchesTarget(page.url(), target)
    ) || null;
  }

  async reopenTargetPage(url) {
    if (!this.context) throw new Error("adapter is not open");

    const parsed = new URL(url);
    if (!isChatGptUrl(parsed.toString())) {
      throw new Error("target recovery requires a ChatGPT URL");
    }
    const target = targetFromUrl(parsed);
    const key = `${target.origin}${target.pathname}`;

    const existing = this.findPageForTarget(target);
    if (existing) return existing;

    const cached = this.targetRecoveryPages.get(key);
    if (cached && !cached.isClosed()) return cached;
    this.targetRecoveryPages.delete(key);

    const page = await this.newChatPage(url);
    this.targetRecoveryPages.set(key, page);

    if (typeof page.once === "function") {
      page.once("close", () => {
        if (this.targetRecoveryPages.get(key) === page) {
          this.targetRecoveryPages.delete(key);
        }
      });
    }

    return page;
  }

  async newChatPage(url = "https://chatgpt.com/") {
    if (!this.context) throw new Error("adapter is not open");

    let page = null;
    try {
      page = await this.context.newPage();
    } catch (error) {
      if (!this.cdpUrl || !isTransientNavigationError(error)) throw error;
      await this.reconnectOverCdp();
      page = await this.context.newPage();
    }

    try {
      // Cold dedicated Chrome can commit chatgpt.com quickly while deferred
      // scripts keep DOMContentLoaded pending for tens of seconds. New Chat
      // usability is verified later by composer/auth probes, so require only
      // a real navigation commit here and keep the existing bounded CDP retry.
      await page.goto(url, {
        waitUntil: "commit",
        timeout: this.timeoutMs
      });
    } catch (error) {
      if (!this.cdpUrl || !isTransientNavigationError(error)) throw error;
      await this.reconnectOverCdp();
      page = await this.context.newPage();
      await page.goto(url, {
        waitUntil: "commit",
        timeout: this.timeoutMs
      });
    }

    await page.waitForTimeout(this.settleMs);

    // A newly created ChatGPT page becomes the runtime's sticky active page.
    // Without this assignment, getActivePage() can keep returning the warm-up
    // or previously active tab even after the runtime has moved to a fresh
    // conversation. That stale identity can make cleanup close the real active
    // conversation after multi-cycle execution.
    this.page = page;
    return page;
  }

  async probePage(page) {
    if (!page || page.isClosed()) throw new Error("page is required");

    if (!isChatGptUrl(page.url())) {
      return {
        snapshot: {
          schemaVersion: "1.0",
          pathKind: "external_auth",
          conversationPath: false,
          composerReady: false,
          assistantMessageCount: 0,
          userMessageCount: 0,
          loginRequired: true,
          hasCaptcha: false,
          responseRunning: false,
          assistantBusy: false,
          hasNetworkError: false,
          hasTransientError: false,
          hasContinueControl: false,
          hasRetryControl: false,
          conversationFull: false,
          conversationMissing: false
        },
        classification: {
          uiState: "LOGIN_REQUIRED",
          observation: "AUTH_REQUIRED"
        }
      };
    }

    const snapshot = await collectSafeUiSnapshot(page);
    const classification = classifyUiSnapshot(snapshot);
    return { snapshot, classification };
  }

  async probe() {
    const page = this.getActivePage();
    if (!page) throw new Error("adapter is not open");
    return this.probePage(page);
  }

  async close() {
    if (this.context && !this.attachedOverCdp) {
      await this.context.close();
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.attachedOverCdp = false;
    this.targetRecoveryPages.clear();
  }
}
