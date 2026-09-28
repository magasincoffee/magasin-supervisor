import test from "node:test";
import assert from "node:assert/strict";

import { waitForChatSurfaceReady } from "../src/runtime/chatgpt-bridge-page-runtime.mjs";

test("Bridge chat readiness waits for hydrated conversation + composer", async () => {
  const observations = [
    { snapshot: { conversationPath: true, composerReady: false } },
    { snapshot: {
      conversationPath: true,
      composerReady: true,
      loginRequired: false,
      hasCaptcha: false,
      hasNetworkError: false,
      hasTransientError: false,
      conversationMissing: false
    } }
  ];
  let calls = 0;
  const browserAdapter = {
    async probePage() {
      const index = Math.min(calls, observations.length - 1);
      calls += 1;
      return observations[index];
    }
  };

  const result = await waitForChatSurfaceReady(
    browserAdapter,
    {},
    "Executor",
    { timeoutMs: 200, pollIntervalMs: 1 }
  );

  assert.equal(result.snapshot.composerReady, true);
  assert.equal(calls, 2);
});

test("Bridge chat readiness fails closed on login intervention", async () => {
  const browserAdapter = {
    async probePage() {
      return { snapshot: { loginRequired: true, composerReady: false } };
    }
  };

  await assert.rejects(
    () => waitForChatSurfaceReady(
      browserAdapter,
      {},
      "Planner",
      { timeoutMs: 50, pollIntervalMs: 1 }
    ),
    /requires owner intervention/
  );
});

test("Bridge chat readiness rejects missing conversation until timeout", async () => {
  const browserAdapter = {
    async probePage() {
      return {
        snapshot: {
          conversationPath: true,
          composerReady: false,
          conversationMissing: true
        }
      };
    }
  };

  await assert.rejects(
    () => waitForChatSurfaceReady(
      browserAdapter,
      {},
      "Executor",
      { timeoutMs: 5, pollIntervalMs: 1 }
    ),
    /did not become ready/
  );
});
