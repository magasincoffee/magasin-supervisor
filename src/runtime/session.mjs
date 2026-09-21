import { ChatGptUiAdapter } from "../ui/playwright-adapter.mjs";
import { retryOperation } from "../retry.mjs";

export function safeConnectionErrorCause(error) {
  const cause = error?.lastError || error?.cause || error;
  const rawCode = String(cause?.code || cause?.cause?.code || "").trim();
  if (rawCode) return rawCode.slice(0, 64).toUpperCase();

  const message = String(cause?.message || "").toLowerCase();
  if (message.includes("econnrefused") || message.includes("connection refused")) {
    return "ECONNREFUSED";
  }
  if (message.includes("websocket")) return "WEBSOCKET_ERROR";
  if (
    message.includes("browser has been closed") ||
    message.includes("target page, context or browser has been closed")
  ) {
    return "BROWSER_CLOSED";
  }
  if (message.includes("socket hang up")) return "SOCKET_HANG_UP";
  if (message.includes("connectovercdp")) return "CONNECT_OVER_CDP";

  const netError = message.match(/net::err_[a-z0-9_]+/i);
  if (netError) return netError[0].toUpperCase();

  const name = String(cause?.name || "").trim();
  if (name && name !== "Error") return name.slice(0, 64);
  return "UNKNOWN_CONNECTION_ERROR";
}

export class SupervisorSession {
  constructor({
    cdpUrl = "http://127.0.0.1:9222",
    adapterFactory = (options) => new ChatGptUiAdapter(options),
    maxConnectRetries = 2,
    retryDelaysMs,
    sleep,
    onEvent = () => {}
  } = {}) {
    this.cdpUrl = cdpUrl;
    this.adapterFactory = adapterFactory;
    this.maxConnectRetries = maxConnectRetries;
    this.retryDelaysMs = retryDelaysMs;
    this.sleep = sleep;
    this.onEvent = onEvent;
    this.adapter = null;
  }

  async connect() {
    if (this.adapter) return this.adapter;

    const adapter = this.adapterFactory({ cdpUrl: this.cdpUrl });
    try {
      await retryOperation({
        operation: async () => {
          await adapter.open();
          return adapter;
        },
        maxRetries: this.maxConnectRetries,
        delaysMs: this.retryDelaysMs,
        sleep: this.sleep,
        onRetry: ({ attempt, delayMs }) => {
          this.onEvent({
            type: "CONNECT_RETRY",
            attempt,
            delayMs
          });
        }
      });
      this.adapter = adapter;
      this.onEvent({ type: "CONNECTED" });
      return adapter;
    } catch (error) {
      await adapter.close().catch(() => {});
      this.onEvent({
        type: "CONNECT_FAILED",
        errorName: error?.name || "Error",
        errorCause: safeConnectionErrorCause(error)
      });
      throw error;
    }
  }

  async probe() {
    const adapter = await this.connect();
    try {
      return await adapter.probe();
    } catch (error) {
      this.onEvent({
        type: "PROBE_FAILED",
        errorName: error?.name || "Error"
      });
      await this.disconnect();
      throw error;
    }
  }

  async reconnect() {
    await this.disconnect();
    this.onEvent({ type: "RECONNECT" });
    return this.connect();
  }

  async disconnect() {
    if (this.adapter) {
      await this.adapter.close().catch(() => {});
      this.adapter = null;
      this.onEvent({ type: "DISCONNECTED" });
    }
  }
}
