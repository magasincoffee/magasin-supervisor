export class RetryBudgetExhaustedError extends Error {
  constructor(message, { attempts, lastError } = {}) {
    super(message);
    this.name = "RetryBudgetExhaustedError";
    this.attempts = attempts ?? 0;
    this.lastError = lastError ?? null;
  }
}

export function defaultRetryDelaysMs(maxRetries = 2) {
  const delays = [];
  for (let i = 0; i < maxRetries; i += 1) {
    delays.push(Math.min(1000 * (2 ** i), 5000));
  }
  return delays;
}

export function isRetryableConnectionError(error) {
  const message = [
    error?.message,
    error?.code,
    error?.cause?.message,
    error?.cause?.code,
    error
  ].filter(Boolean).map((value) => String(value).toLowerCase()).join(" | ");

  return [
    "econnrefused",
    "connection refused",
    "fetch failed",
    "websocket error",
    "connectovercdp",
    "browser has been closed",
    "target page, context or browser has been closed",
    "socket hang up",
    "network error",
    "net::err_"
  ].some((needle) => message.includes(needle));
}

export async function retryOperation({
  operation,
  shouldRetry = isRetryableConnectionError,
  maxRetries = 2,
  delaysMs = defaultRetryDelaysMs(maxRetries),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRetry = () => {}
}) {
  if (typeof operation !== "function") throw new TypeError("operation must be a function");
  if (typeof shouldRetry !== "function") throw new TypeError("shouldRetry must be a function");
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError("maxRetries must be a non-negative integer");
  }

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation({ attempt });
    } catch (error) {
      lastError = error;
      const canRetry = attempt < maxRetries && Boolean(shouldRetry(error));
      if (!canRetry) {
        if (attempt >= maxRetries && shouldRetry(error)) {
          throw new RetryBudgetExhaustedError("retry budget exhausted", {
            attempts: attempt + 1,
            lastError: error
          });
        }
        throw error;
      }

      const delayMs = Number(delaysMs[attempt] ?? 0);
      onRetry({ attempt: attempt + 1, delayMs, error });
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  throw new RetryBudgetExhaustedError("retry budget exhausted", {
    attempts: maxRetries + 1,
    lastError
  });
}
