import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

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


test("Bridge startup reloads Planner and Executor sequentially", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/chatgpt-bridge-page-runtime.mjs", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("// Reload once at process startup");
  const end = source.indexOf("const injections = await Promise.all", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);

  const plannerReload = block.indexOf("warm.plannerPage.reload");
  const plannerReady = block.indexOf('waitForChatSurfaceReady(browserAdapter, warm.plannerPage, "Planner")');
  const executorReload = block.indexOf("warm.executorPage.reload");
  const executorReady = block.indexOf('waitForChatSurfaceReady(browserAdapter, warm.executorPage, "Executor")');

  assert.ok(plannerReload >= 0);
  assert.ok(plannerReady > plannerReload);
  assert.ok(executorReload > plannerReady);
  assert.ok(executorReady > executorReload);
  assert.doesNotMatch(block, /Promise\.all\(\[\s*warm\.plannerPage\.reload/);
});
