import test from "node:test";
import assert from "node:assert/strict";

import { ACTIONS, decideContinuation } from "../src/decision.mjs";
import { classifyUiSnapshot } from "../src/ui/classifier.mjs";
import { executeDecision } from "../src/ui/actions.mjs";

function projectState() {
  return {
    project: "MAGASIN Business OS",
    current_phase: "P1",
    current_task: "TASK-006",
    status: "RUNNING",
    autonomy: "AUTO_CONTINUE",
    blocked: false,
    requires_user: false,
    next_task: "TASK-007"
  };
}

test("Vietnamese timeout surface maps to bounded safe RETRY", async () => {
  const classification = classifyUiSnapshot({
    composerReady: true,
    assistantMessageCount: 1,
    userMessageCount: 1,
    conversationPath: true,
    loginRequired: false,
    hasCaptcha: false,
    responseRunning: false,
    hasNetworkError: false,
    hasTransientError: true
  });

  assert.equal(classification.observation, "TRANSIENT_ERROR");

  const decision = decideContinuation({
    projectState: projectState(),
    observation: classification.observation,
    retryCount: 0,
    maxRetries: 2
  });

  assert.equal(decision.action, ACTIONS.RETRY);

  let clicks = 0;
  const page = {
    async evaluate() {
      return [{ text: "Thử lại", ariaLabel: "", testId: null }];
    },
    locator() {
      return {
        first() { return this; },
        async isVisible() { return true; }
      };
    },
    getByRole(role, options) {
      assert.equal(role, "button");
      assert.equal(options.name, "Thử lại");
      return {
        first() { return this; },
        async isVisible() { return true; },
        async click() { clicks += 1; }
      };
    }
  };

  const execution = await executeDecision({
    page,
    decision,
    dryRun: false
  });

  assert.equal(execution.executed, true);
  assert.equal(execution.target, "SAFE_RETRY_CONTROL");
  assert.equal(clicks, 1);
});
