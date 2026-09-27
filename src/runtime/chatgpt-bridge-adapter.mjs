import crypto from "node:crypto";

export const CHATGPT_BRIDGE_UPSTREAM_REPOSITORY = "https://github.com/OLmatter/chatgpt-bridge";
export const CHATGPT_BRIDGE_PINNED_UPSTREAM_COMMIT = "848efb9e85f52f251c82ab099747833c0693c072";
export const CHATGPT_BRIDGE_DEFAULT_BASE_URL = "http://127.0.0.1:5000";
export const CHATGPT_BRIDGE_DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const CHATGPT_BRIDGE_DEFAULT_RESPONSE_TIMEOUT_MS = 180_000;
export const CHATGPT_BRIDGE_DEFAULT_POLL_INTERVAL_MS = 500;

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export class ChatGptBridgeError extends Error {
  constructor(message, {
    code = "BRIDGE_ERROR",
    cause = null,
    details = null
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ChatGptBridgeError";
    this.code = code;
    this.details = details;
  }
}

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function requireString(value, label, {
  allowEmpty = false,
  maxLength = 100_000
} = {}) {
  const text = String(value ?? "");
  if ((!allowEmpty && !text.trim()) || text.length > maxLength) {
    throw new ChatGptBridgeError(
      `${label} must be ${allowEmpty ? "a bounded" : "a non-empty bounded"} string`,
      { code: "INVALID_ARGUMENT" }
    );
  }
  return text;
}

export function normalizeBridgeBaseUrl(value = CHATGPT_BRIDGE_DEFAULT_BASE_URL) {
  let url;
  try {
    url = new URL(String(value || CHATGPT_BRIDGE_DEFAULT_BASE_URL));
  } catch (error) {
    throw new ChatGptBridgeError("Bridge base URL is invalid", {
      code: "INVALID_BASE_URL",
      cause: error
    });
  }

  if (url.protocol !== "http:" || !LOCAL_HOSTS.has(url.hostname)) {
    throw new ChatGptBridgeError(
      "Bridge base URL must be local HTTP on 127.0.0.1, localhost, or ::1",
      { code: "NON_LOCAL_BRIDGE_URL" }
    );
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new ChatGptBridgeError("Bridge base URL must not contain credentials, query, or hash", {
      code: "INVALID_BASE_URL"
    });
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname && pathname !== "/") {
    throw new ChatGptBridgeError("Bridge base URL must not contain a path prefix", {
      code: "INVALID_BASE_URL"
    });
  }

  return url.origin;
}

function pageId(value) {
  return requireString(value, "page_id", { maxLength: 512 }).trim();
}

function normalizeRecentTurns(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-20).map((turn) => ({
    role: String(turn?.role || "").trim(),
    text: String(turn?.text || "")
  }));
}

export function normalizeBridgePage(value) {
  if (!value || typeof value !== "object") {
    throw new ChatGptBridgeError("Bridge page summary is malformed", {
      code: "MALFORMED_BRIDGE_RESPONSE"
    });
  }

  return {
    page_id: pageId(value.page_id),
    title: String(value.title || ""),
    url: String(value.url || ""),
    alive: Boolean(value.alive),
    is_generating: Boolean(value.is_generating),
    assistant_count: finiteNonNegative(value.assistant_count),
    last_msg: String(value.last_msg || ""),
    last_poll_ago: finiteNonNegative(value.last_poll_ago)
  };
}

export function normalizeBridgeSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatGptBridgeError("Bridge snapshot is malformed", {
      code: "MALFORMED_BRIDGE_RESPONSE"
    });
  }
  if (value.error) {
    throw new ChatGptBridgeError("Bridge snapshot is unavailable", {
      code: "SNAPSHOT_UNAVAILABLE",
      details: { error: String(value.error).slice(0, 500) }
    });
  }

  return {
    site: String(value.site || ""),
    url: String(value.url || ""),
    title: String(value.title || ""),
    has_editor: Boolean(value.hasEditor),
    editor_text: String(value.editorText || ""),
    assistant_count: finiteNonNegative(value.assistantCount),
    is_generating: Boolean(value.isGenerating),
    recent_turns: normalizeRecentTurns(value.recentTurns),
    last_assistant: String(value.lastAssistant || "")
  };
}

function latestAssistantText(snapshot) {
  if (snapshot.last_assistant.trim()) return snapshot.last_assistant.trim();
  for (let i = snapshot.recent_turns.length - 1; i >= 0; i -= 1) {
    const turn = snapshot.recent_turns[i];
    if (turn.role === "assistant" && turn.text.trim()) return turn.text.trim();
  }
  return "";
}

export function bridgeAssistantDigest(snapshot) {
  const normalized = normalizeBridgeSnapshot({
    site: snapshot.site,
    url: snapshot.url,
    title: snapshot.title,
    hasEditor: snapshot.has_editor ?? snapshot.hasEditor,
    editorText: snapshot.editor_text ?? snapshot.editorText,
    assistantCount: snapshot.assistant_count ?? snapshot.assistantCount,
    isGenerating: snapshot.is_generating ?? snapshot.isGenerating,
    recentTurns: snapshot.recent_turns ?? snapshot.recentTurns,
    lastAssistant: snapshot.last_assistant ?? snapshot.lastAssistant
  });
  return crypto
    .createHash("sha256")
    .update(latestAssistantText(normalized), "utf8")
    .digest("hex");
}

export function bridgeResponseBaseline(snapshot) {
  const normalized = snapshot?.assistant_count !== undefined
    ? {
        ...snapshot,
        recent_turns: Array.isArray(snapshot.recent_turns) ? snapshot.recent_turns : [],
        last_assistant: String(snapshot.last_assistant || "")
      }
    : normalizeBridgeSnapshot(snapshot);

  return {
    assistant_count: finiteNonNegative(normalized.assistant_count),
    assistant_digest: bridgeAssistantDigest(normalized),
    is_generating: Boolean(normalized.is_generating)
  };
}

function changedFromBaseline(snapshot, baseline) {
  const currentDigest = bridgeAssistantDigest(snapshot);
  const countAdvanced = snapshot.assistant_count > baseline.assistant_count;
  const digestChanged =
    Boolean(latestAssistantText(snapshot)) &&
    currentDigest !== baseline.assistant_digest;

  return {
    changed: countAdvanced || digestChanged,
    count_advanced: countAdvanced,
    digest_changed: digestChanged,
    assistant_digest: currentDigest
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ChatGptBridgeAdapter {
  constructor({
    baseUrl = CHATGPT_BRIDGE_DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = CHATGPT_BRIDGE_DEFAULT_REQUEST_TIMEOUT_MS,
    responseTimeoutMs = CHATGPT_BRIDGE_DEFAULT_RESPONSE_TIMEOUT_MS,
    pollIntervalMs = CHATGPT_BRIDGE_DEFAULT_POLL_INTERVAL_MS,
    sleepImpl = defaultSleep,
    nowImpl = Date.now
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new ChatGptBridgeError("fetchImpl must be a function", {
        code: "INVALID_ARGUMENT"
      });
    }
    if (typeof sleepImpl !== "function" || typeof nowImpl !== "function") {
      throw new ChatGptBridgeError("sleepImpl and nowImpl must be functions", {
        code: "INVALID_ARGUMENT"
      });
    }

    this.baseUrl = normalizeBridgeBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = Math.max(1, Number(requestTimeoutMs) || CHATGPT_BRIDGE_DEFAULT_REQUEST_TIMEOUT_MS);
    this.responseTimeoutMs = Math.max(1, Number(responseTimeoutMs) || CHATGPT_BRIDGE_DEFAULT_RESPONSE_TIMEOUT_MS);
    this.pollIntervalMs = Math.max(1, Number(pollIntervalMs) || CHATGPT_BRIDGE_DEFAULT_POLL_INTERVAL_MS);
    this.sleepImpl = sleepImpl;
    this.nowImpl = nowImpl;
  }

  async request(pathname, {
    method = "GET",
    body = undefined,
    timeoutMs = this.requestTimeoutMs
  } = {}) {
    const url = new URL(pathname, this.baseUrl);
    if (url.origin !== this.baseUrl) {
      throw new ChatGptBridgeError("Bridge request escaped configured local origin", {
        code: "INVALID_REQUEST_PATH"
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || this.requestTimeoutMs));

    let response;
    let text;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });

      if (!response || typeof response.text !== "function") {
        throw new ChatGptBridgeError("Bridge fetch returned an invalid response object", {
          code: "MALFORMED_BRIDGE_RESPONSE"
        });
      }
      text = await response.text();
    } catch (error) {
      if (error instanceof ChatGptBridgeError) throw error;
      throw new ChatGptBridgeError("Bridge request failed", {
        code: error?.name === "AbortError" ? "BRIDGE_TIMEOUT" : "BRIDGE_UNREACHABLE",
        cause: error,
        details: { method, pathname: url.pathname }
      });
    } finally {
      clearTimeout(timer);
    }

    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (error) {
      throw new ChatGptBridgeError("Bridge returned non-JSON content", {
        code: "MALFORMED_BRIDGE_RESPONSE",
        cause: error,
        details: { status: response.status, pathname: url.pathname }
      });
    }

    if (!response.ok) {
      throw new ChatGptBridgeError("Bridge returned an HTTP error", {
        code: "BRIDGE_HTTP_ERROR",
        details: {
          status: response.status,
          pathname: url.pathname,
          detail: String(payload?.detail || payload?.error || "").slice(0, 500)
        }
      });
    }

    return payload;
  }

  async status() {
    const value = await this.request("/status");
    if (!value || typeof value !== "object") {
      throw new ChatGptBridgeError("Bridge status is malformed", {
        code: "MALFORMED_BRIDGE_RESPONSE"
      });
    }

    return {
      pages_connected: finiteNonNegative(value.pages_connected),
      pages_alive: finiteNonNegative(value.pages_alive),
      supervisor_running: Boolean(value.supervisor_running)
    };
  }

  async listPages() {
    const value = await this.request("/pages");
    if (!value || !Array.isArray(value.pages)) {
      throw new ChatGptBridgeError("Bridge pages response is malformed", {
        code: "MALFORMED_BRIDGE_RESPONSE"
      });
    }
    return value.pages.map(normalizeBridgePage);
  }

  async getState(pageId) {
    const target = pageId(pageId);
    const pages = await this.listPages();
    const page = pages.find((candidate) => candidate.page_id === target);
    if (!page) {
      throw new ChatGptBridgeError("Bridge page is not registered", {
        code: "PAGE_NOT_FOUND",
        details: { page_id: target }
      });
    }
    return page;
  }

  async getSnapshot(pageIdValue) {
    const target = pageId(pageIdValue);
    const query = new URLSearchParams({ page_id: target });
    const value = await this.request("/snapshot?" + query.toString());
    return normalizeBridgeSnapshot(value);
  }

  async captureBaseline(pageIdValue) {
    const snapshot = await this.getSnapshot(pageIdValue);
    return {
      page_id: pageId(pageIdValue),
      ...bridgeResponseBaseline(snapshot)
    };
  }

  async sendAsync(pageIdValue, message) {
    const target = pageId(pageIdValue);
    const text = requireString(message, "message", { maxLength: 100_000 });

    const value = await this.request("/send_async", {
      method: "POST",
      body: {
        page_id: target,
        text
      }
    });

    if (!value || value.ok !== true || !String(value.cmd_id || "").trim()) {
      throw new ChatGptBridgeError("Bridge did not confirm async command enqueue", {
        code: "ASYNC_ENQUEUE_REJECTED"
      });
    }

    return {
      ok: true,
      page_id: target,
      cmd_id: String(value.cmd_id).trim()
    };
  }

  async waitResponse(pageIdValue, baselineValue, {
    timeoutMs = this.responseTimeoutMs,
    pollIntervalMs = this.pollIntervalMs
  } = {}) {
    const target = pageId(pageIdValue);
    if (!baselineValue || typeof baselineValue !== "object") {
      throw new ChatGptBridgeError("waitResponse requires a response baseline", {
        code: "INVALID_BASELINE"
      });
    }

    const baselinePageId = pageId(baselineValue.page_id);
    if (baselinePageId !== target) {
      throw new ChatGptBridgeError("Response baseline belongs to a different Bridge page", {
        code: "BASELINE_PAGE_MISMATCH",
        details: {
          page_id: target,
          baseline_page_id: baselinePageId
        }
      });
    }

    const assistantDigest = requireString(
      baselineValue.assistant_digest,
      "baseline assistant_digest",
      { maxLength: 128 }
    ).trim();
    if (!/^[a-f0-9]{64}$/i.test(assistantDigest)) {
      throw new ChatGptBridgeError("baseline assistant_digest must be a SHA-256 digest", {
        code: "INVALID_BASELINE"
      });
    }

    const baseline = {
      assistant_count: finiteNonNegative(baselineValue.assistant_count),
      assistant_digest: assistantDigest.toLowerCase(),
      is_generating: Boolean(baselineValue.is_generating)
    };

    if (baseline.is_generating) {
      throw new ChatGptBridgeError(
        "Cannot establish exact new-response evidence from a generating baseline",
        { code: "AMBIGUOUS_BASELINE" }
      );
    }

    const deadline = this.nowImpl() + Math.max(1, Number(timeoutMs) || this.responseTimeoutMs);
    let lastSnapshot = null;

    while (this.nowImpl() <= deadline) {
      lastSnapshot = await this.getSnapshot(target);
      const evidence = changedFromBaseline(lastSnapshot, baseline);
      if (
        evidence.changed &&
        !lastSnapshot.is_generating &&
        Boolean(latestAssistantText(lastSnapshot))
      ) {
        return {
          page_id: target,
          snapshot: lastSnapshot,
          evidence: {
            response_changed: true,
            count_advanced: evidence.count_advanced,
            digest_changed: evidence.digest_changed,
            assistant_digest: evidence.assistant_digest
          }
        };
      }
      await this.sleepImpl(Math.max(1, Number(pollIntervalMs) || this.pollIntervalMs));
    }

    throw new ChatGptBridgeError("Timed out waiting for a new Bridge assistant response", {
      code: "RESPONSE_TIMEOUT",
      details: {
        page_id: target,
        baseline_assistant_count: baseline.assistant_count,
        last_assistant_count: lastSnapshot?.assistant_count ?? null
      }
    });
  }

  async send(pageIdValue, message, options = {}) {
    const target = pageId(pageIdValue);
    const baseline = await this.captureBaseline(target);
    if (baseline.is_generating) {
      throw new ChatGptBridgeError(
        "Cannot send while the target page is already generating",
        { code: "PAGE_BUSY" }
      );
    }

    const queued = await this.sendAsync(target, message);
    const observed = await this.waitResponse(target, baseline, options);
    return {
      ...queued,
      ...observed
    };
  }
}
