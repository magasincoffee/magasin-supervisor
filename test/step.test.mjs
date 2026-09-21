import test from "node:test";
import assert from "node:assert/strict";

import { ACTIONS } from "../src/decision.mjs";
import { runSupervisorStep } from "../src/runtime/step.mjs";

function projectState(overrides = {}) {
  return {
    project: "Example Project",
    current_phase: "P1",
    current_task: "PLATFORM-006",
    status: "RUNNING",
    autonomy: "AUTO_CONTINUE",
    blocked: false,
    requires_user: false,
    next_task: "PLATFORM-007",
    ...overrides
  };
}

test("step plans continue when UI is idle and state allows autonomy", async () => {
  const page = {
    async evaluate() { return []; },
    locator() {
      return {
        first() { return this; },
        async isVisible() { return true; }
      };
    },
    getByRole() {
      return {
        first() { return this; },
        async isVisible() { return false; }
      };
    }
  };

  const session = {
    adapter: { getActivePage: () => page },
    async probe() {
      return {
        classification: { observation: "RESPONSE_COMPLETE" },
        snapshot: {}
      };
    }
  };

  const result = await runSupervisorStep({
    session,
    projectState: projectState(),
    dryRun: true
  });

  assert.equal(result.decision.action, ACTIONS.CONTINUE);
  assert.equal(result.execution.target, "COMPOSER_SEND");
  assert.equal(result.execution.executed, false);
});

test("step stops before UI action when owner is required", async () => {
  let evaluated = false;
  const page = {
    async evaluate() { evaluated = true; return []; },
    locator() {
      return {
        first() { return this; },
        async isVisible() { return true; }
      };
    }
  };

  const session = {
    adapter: { getActivePage: () => page },
    async probe() {
      return {
        classification: { observation: "RESPONSE_COMPLETE" },
        snapshot: {}
      };
    }
  };

  const result = await runSupervisorStep({
    session,
    projectState: projectState({ requires_user: true, status: "WAIT_USER" }),
    dryRun: false
  });

  assert.equal(result.decision.action, ACTIONS.STOP_WAIT_USER);
  assert.equal(result.execution.executed, false);
  assert.equal(evaluated, true);
});
