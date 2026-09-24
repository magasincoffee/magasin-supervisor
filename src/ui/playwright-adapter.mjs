import fs from "node:fs";
import path from "node:path";

import { classifyUiSnapshot } from "./classifier.mjs";
import { collectSafeUiSnapshot } from "./snapshot.mjs";

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
    settleMs = 2_500,
    cdpUrl = null
  } = {}) {
    this.profileDir = profileDir;
    this.chromeExecutable = chromeExecutable;
    this.url = url;
    this.headless = headless;
    this.timeoutMs = timeoutMs;
    this.settleMs = settleMs;
    this.cdpUrl = cdpUrl;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.attachedOverCdp = false;
    this.targetRecoveryPages = new Map();
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
    this.context.setDefaultTimeout(this.timeoutMs);
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

    this.context.setDefaultTimeout(this.timeoutMs);
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

  async listRecentConversationUrls(page, { limit = 20 } = {}) {
    if (!page || page.isClosed()) return [];
    const urls = await page.evaluate((maxItems) => {
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
        if (out.length >= maxItems) break;
      }
      return out;
    }, Math.max(1, Math.min(50, Number(limit) || 20)));
    return Array.isArray(urls) ? urls : [];
  }

  findPageForTarget(target) {
    if (!target?.origin || !target?.pathname) return null;
    return this.getChatGptPages().find((page) => {
      try {
        const url = new URL(page.url());
        return url.origin === target.origin && url.pathname === target.pathname;
      } catch {
        return false;
      }
    }) || null;
  }

  async reopenTargetPage(url) {
    if (!this.context) throw new Error("adapter is not open");

    const parsed = new URL(url);
    if (!isChatGptUrl(parsed.toString())) {
      throw new Error("target recovery requires a ChatGPT URL");
    }
    const key = `${parsed.origin}${parsed.pathname}`;

    const existing = this.getChatGptPages().find((page) => {
      try {
        const current = new URL(page.url());
        return current.origin === parsed.origin && current.pathname === parsed.pathname;
      } catch {
        return false;
      }
    });
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

  async newChatPage(
    url = "https://chatgpt.com/",
    { allowTransientRetry = true } = {}
  ) {
    if (!this.context) throw new Error("adapter is not open");

    let page = null;
    try {
      page = await this.context.newPage();
    } catch (error) {
      if (
        !allowTransientRetry ||
        !this.cdpUrl ||
        !isTransientNavigationError(error)
      ) throw error;
      await this.reconnectOverCdp();
      page = await this.context.newPage();
    }

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs
      });
    } catch (error) {
      if (
        !allowTransientRetry ||
        !this.cdpUrl ||
        !isTransientNavigationError(error)
      ) throw error;
      await this.reconnectOverCdp();
      page = await this.context.newPage();
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs
      });
    }

    await page.waitForTimeout(this.settleMs);
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
