import test from "node:test";
import assert from "node:assert/strict";

import {
  ChatGptBridgeError
} from "../src/runtime/chatgpt-bridge-adapter.mjs";
import {
  bindPlannerExecutorBridgePages,
  normalizeBridgeRoleTargets,
  reacquireBridgeRoleBinding
} from "../src/runtime/chatgpt-bridge-binding.mjs";

function adapterFixture(pages, snapshots) {
  return {
    async listPages() {
      return pages;
    },
    async getSnapshot(pageId) {
      if (!(pageId in snapshots)) {
        throw new Error("missing snapshot " + pageId);
      }
      return snapshots[pageId];
    }
  };
}

test("normalizes exact Planner and Executor ChatGPT conversation targets", () => {
  const plannerId = "11111111-1111-1111-1111-111111111111";
  const executorId = "22222222-2222-2222-2222-222222222222";
  const value = normalizeBridgeRoleTargets({
    plannerUrl: "https://chatgpt.com/c/" + plannerId + "?x=1#frag",
    executorUrl: "https://chatgpt.com/c/" + executorId + "/"
  });
  assert.equal(value.planner.canonical_url, "https://chatgpt.com/c/" + plannerId);
  assert.equal(value.executor.canonical_url, "https://chatgpt.com/c/" + executorId);
});

test("nested GPT/Project route resolves to canonical conversation identity", () => {
  const conversationId = "12345678-1234-1234-1234-123456789abc";
  const value = normalizeBridgeRoleTargets({
    plannerUrl: "https://chatgpt.com/g/g-p-demo/c/" + conversationId,
    executorUrl: "https://chatgpt.com/c/executor-456"
  });
  assert.equal(
    value.planner.canonical_url,
    "https://chatgpt.com/c/" + conversationId
  );
});

test("fails closed when Planner and Executor URLs identify the same conversation", () => {
  assert.throws(
    () => normalizeBridgeRoleTargets({
      plannerUrl: "https://chatgpt.com/c/same?x=1",
      executorUrl: "https://chatgpt.com/c/same#other"
    }),
    (error) => error instanceof ChatGptBridgeError && error.code === "ROLE_TARGET_COLLISION"
  );
});

test("binds exact role URLs to two distinct alive Bridge page_id values", async () => {
  const adapter = adapterFixture(
    [
      { page_id: "planner_pid", alive: true, url: "https://chatgpt.com/c/planner" },
      { page_id: "executor_pid", alive: true, url: "https://chatgpt.com/c/executor" },
      { page_id: "unrelated_pid", alive: true, url: "https://chatgpt.com/c/unrelated" }
    ],
    {
      planner_pid: { url: "https://chatgpt.com/c/planner", assistant_count: 1 },
      executor_pid: { url: "https://chatgpt.com/c/executor", assistant_count: 2 },
      unrelated_pid: { url: "https://chatgpt.com/c/unrelated", assistant_count: 3 }
    }
  );

  const binding = await bindPlannerExecutorBridgePages(adapter, {
    plannerUrl: "https://chatgpt.com/c/planner",
    executorUrl: "https://chatgpt.com/c/executor",
    plannerTargetRevision: 4,
    executorTargetRevision: 7
  });

  assert.deepEqual(binding.planner, {
    role: "planner",
    chat_url: "https://chatgpt.com/c/planner",
    page_id: "planner_pid",
    target_revision: 4
  });
  assert.deepEqual(binding.executor, {
    role: "executor",
    chat_url: "https://chatgpt.com/c/executor",
    page_id: "executor_pid",
    target_revision: 7
  });
  assert.equal(binding.observed_page_count, 3);
});

test("never auto-adopts an unrelated ChatGPT page when a role target is missing", async () => {
  const adapter = adapterFixture(
    [
      { page_id: "other_pid", alive: true, url: "https://chatgpt.com/c/other" }
    ],
    {
      other_pid: { url: "https://chatgpt.com/c/other" }
    }
  );

  await assert.rejects(
    () => bindPlannerExecutorBridgePages(adapter, {
      plannerUrl: "https://chatgpt.com/c/planner",
      executorUrl: "https://chatgpt.com/c/executor"
    }),
    (error) => error instanceof ChatGptBridgeError && error.code === "ROLE_TARGET_NOT_FOUND"
  );
});

test("duplicate tabs for one role target are ambiguous and fail closed", async () => {
  const adapter = adapterFixture(
    [
      { page_id: "planner_a", alive: true },
      { page_id: "planner_b", alive: true },
      { page_id: "executor_pid", alive: true }
    ],
    {
      planner_a: { url: "https://chatgpt.com/c/planner" },
      planner_b: { url: "https://chatgpt.com/c/planner" },
      executor_pid: { url: "https://chatgpt.com/c/executor" }
    }
  );

  await assert.rejects(
    () => bindPlannerExecutorBridgePages(adapter, {
      plannerUrl: "https://chatgpt.com/c/planner",
      executorUrl: "https://chatgpt.com/c/executor"
    }),
    (error) => error instanceof ChatGptBridgeError && error.code === "ROLE_TARGET_AMBIGUOUS"
  );
});

test("dead Bridge pages are not eligible role bindings", async () => {
  const adapter = adapterFixture(
    [
      { page_id: "planner_dead", alive: false },
      { page_id: "executor_pid", alive: true }
    ],
    {
      planner_dead: { url: "https://chatgpt.com/c/planner" },
      executor_pid: { url: "https://chatgpt.com/c/executor" }
    }
  );

  await assert.rejects(
    () => bindPlannerExecutorBridgePages(adapter, {
      plannerUrl: "https://chatgpt.com/c/planner",
      executorUrl: "https://chatgpt.com/c/executor"
    }),
    (error) => error instanceof ChatGptBridgeError && error.code === "ROLE_TARGET_NOT_FOUND"
  );
});

test("reacquire after reload may change page_id while preserving role URLs and target revisions", async () => {
  const initial = {
    planner: {
      role: "planner",
      chat_url: "https://chatgpt.com/c/planner",
      page_id: "planner_old",
      target_revision: 3
    },
    executor: {
      role: "executor",
      chat_url: "https://chatgpt.com/c/executor",
      page_id: "executor_old",
      target_revision: 5
    }
  };

  const adapter = adapterFixture(
    [
      { page_id: "planner_new", alive: true },
      { page_id: "executor_new", alive: true }
    ],
    {
      planner_new: { url: "https://chatgpt.com/c/planner" },
      executor_new: { url: "https://chatgpt.com/c/executor" }
    }
  );

  const rebound = await reacquireBridgeRoleBinding(adapter, initial);
  assert.equal(rebound.planner.page_id, "planner_new");
  assert.equal(rebound.executor.page_id, "executor_new");
  assert.equal(rebound.planner.chat_url, initial.planner.chat_url);
  assert.equal(rebound.executor.chat_url, initial.executor.chat_url);
  assert.equal(rebound.planner.target_revision, 3);
  assert.equal(rebound.executor.target_revision, 5);
});

test("non-ChatGPT or non-HTTPS targets are rejected before page inspection", () => {
  assert.throws(
    () => normalizeBridgeRoleTargets({
      plannerUrl: "http://chatgpt.com/c/planner",
      executorUrl: "https://chatgpt.com/c/executor"
    }),
    (error) => error instanceof ChatGptBridgeError && error.code === "INVALID_CHAT_TARGET_URL"
  );
  assert.throws(
    () => normalizeBridgeRoleTargets({
      plannerUrl: "https://example.com/c/planner",
      executorUrl: "https://chatgpt.com/c/executor"
    }),
    (error) => error instanceof ChatGptBridgeError && error.code === "INVALID_CHAT_TARGET_URL"
  );
});
