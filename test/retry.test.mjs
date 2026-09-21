import test from "node:test";
import assert from "node:assert/strict";

import {
  RetryBudgetExhaustedError,
  isRetryableConnectionError,
  retryOperation
} from "../src/retry.mjs";

test("retryOperation retries retryable failures then succeeds", async () => {
  let calls = 0;
  const events = [];

  const result = await retryOperation({
    operation: async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNREFUSED 127.0.0.1:9222");
      return "ok";
    },
    maxRetries: 2,
    delaysMs: [0, 0],
    onRetry: (event) => events.push(event)
  });

  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.equal(events.length, 2);
});

test("retryOperation fails immediately for non-retryable defects", async () => {
  let calls = 0;

  await assert.rejects(
    () => retryOperation({
      operation: async () => {
        calls += 1;
        throw new Error("invalid selector contract");
      },
      maxRetries: 3,
      delaysMs: [0, 0, 0]
    }),
    /invalid selector contract/
  );

  assert.equal(calls, 1);
});

test("retryOperation throws typed error after retry budget", async () => {
  await assert.rejects(
    () => retryOperation({
      operation: async () => {
        throw new Error("connection refused");
      },
      maxRetries: 2,
      delaysMs: [0, 0]
    }),
    (error) => {
      assert.ok(error instanceof RetryBudgetExhaustedError);
      assert.equal(error.attempts, 3);
      return true;
    }
  );
});

test("connection error classifier stays narrow", () => {
  assert.equal(isRetryableConnectionError(new Error("ECONNREFUSED")), true);
  assert.equal(isRetryableConnectionError(new Error("network error")), true);
  assert.equal(isRetryableConnectionError(new Error("permission denied")), false);
  assert.equal(isRetryableConnectionError(new Error("invalid business rule")), false);
});


test("nested fetch failure is retryable for CDP discovery", () => {
  const error = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9230"), {
      code: "ECONNREFUSED"
    })
  });
  assert.equal(isRetryableConnectionError(error), true);
});
