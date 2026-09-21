import test from "node:test";
import assert from "node:assert/strict";

import { SupervisorSession } from "../src/runtime/session.mjs";

function fakeAdapter({ openFailures = 0, probeError = null } = {}) {
  let opens = 0;
  let closes = 0;

  return {
    get opens() { return opens; },
    get closes() { return closes; },
    async open() {
      opens += 1;
      if (opens <= openFailures) {
        throw new Error("ECONNREFUSED 127.0.0.1:9222");
      }
    },
    async probe() {
      if (probeError) throw probeError;
      return { classification: { uiState: "READY_IDLE" } };
    },
    async close() {
      closes += 1;
    }
  };
}

test("SupervisorSession reconnects to CDP within bounded budget", async () => {
  const adapter = fakeAdapter({ openFailures: 1 });
  const events = [];

  const session = new SupervisorSession({
    adapterFactory: () => adapter,
    maxConnectRetries: 2,
    retryDelaysMs: [0, 0],
    onEvent: (event) => events.push(event)
  });

  await session.connect();

  assert.equal(adapter.opens, 2);
  assert.ok(events.some((event) => event.type === "CONNECT_RETRY"));
  assert.ok(events.some((event) => event.type === "CONNECTED"));
});

test("probe failure disconnects so next probe can reconnect", async () => {
  const first = fakeAdapter({ probeError: new Error("target page, context or browser has been closed") });
  const second = fakeAdapter();
  let factoryCalls = 0;

  const session = new SupervisorSession({
    adapterFactory: () => {
      factoryCalls += 1;
      return factoryCalls === 1 ? first : second;
    },
    maxConnectRetries: 0
  });

  await assert.rejects(() => session.probe(), /target page/);
  const result = await session.probe();

  assert.equal(result.classification.uiState, "READY_IDLE");
  assert.equal(factoryCalls, 2);
  assert.equal(first.closes, 1);
});

test("disconnect is idempotent", async () => {
  const adapter = fakeAdapter();
  const session = new SupervisorSession({
    adapterFactory: () => adapter,
    maxConnectRetries: 0
  });

  await session.connect();
  await session.disconnect();
  await session.disconnect();

  assert.equal(adapter.closes, 1);
});


test("exhausted CDP retries emit a bounded safe root-cause tag", async () => {
  const adapter = fakeAdapter({ openFailures: 3 });
  const events = [];
  const session = new SupervisorSession({
    adapterFactory: () => adapter,
    maxConnectRetries: 2,
    retryDelaysMs: [0, 0],
    onEvent: (event) => events.push(event)
  });

  await assert.rejects(
    () => session.connect(),
    (error) => error?.name === "RetryBudgetExhaustedError"
  );

  const failed = events.find((event) => event.type === "CONNECT_FAILED");
  assert.equal(failed?.errorName, "RetryBudgetExhaustedError");
  assert.equal(failed?.errorCause, "ECONNREFUSED");
  assert.equal("errorMessage" in failed, false);
});
