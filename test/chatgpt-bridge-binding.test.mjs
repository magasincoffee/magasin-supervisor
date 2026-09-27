import test from "node:test";
import assert from "node:assert/strict";

import {
  CHATGPT_BRIDGE_BINDING_SCHEMA,
  ChatGptBridgeBindingError,
  bindPlannerExecutorBridgePages,
  reacquirePlannerExecutorBridgePages,
  validateBridgeRoleBinding,
  validatePlannerExecutorBridgeUrls
} from "../src/runtime/chatgpt-bridge-binding.mjs";

const PLANNER_ID = "11111111-1111-4111-8111-111111111111";
const EXECUTOR_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

const PLANNER_URL = `https://chatgpt.com/c/${PLANNER_ID}`;
const EXECUTOR_URL = `https://chatgpt.com/c/${EXECUTOR_ID}`;

function page(page_id, url, {
  alive = true,
  title = ""
} = {}) {
  return {
    page_id,
    url,
    title,
    alive,
    is_generating: false,
    assistant_count: 0,
    last_msg: "",
    last_poll_ago: 0
  };
}

function adapterWith(pages) {
  return {
    async listPages() {
      return pages;
    }
  };
}

test("Bridge binding resolves exact Planner and Executor URLs to distinct page_id values", async () => {
  const binding = await bindPlannerExecutorBridgePages(
    adapterWith([
      page("planner_page", PLANNER_URL, { title: "Planner" }),
      page("executor_page", EXECUTOR_URL, { title: "Executor" })
    ]),
    {
      plannerUrl: PLANNER_URL,
      executorUrl: EXECUTOR_URL
    }
  );

  assert.equal(binding.schema_version, CHATGPT_BRIDGE_BINDING_SCHEMA);
  assert.equal(binding.planner.page_id, "planner_page");
  assert.equal(binding.executor.page_id, "executor_page");
  assert.equal(binding.planner.canonical_target, PLANNER_URL);
  assert.equal(binding.executor.canonical_target, EXECUTOR_URL);
  assert.equal(binding.exact_page_set, true);
  assert.deepEqual(binding.unrelated_page_ids, []);
});

test("binding reuses canonical conversation identity for Project/GPT presentation URLs", async () => {
  const plannerPresentation =
    `https://chatgpt.com/g/g-p-example/c/${PLANNER_ID}`;
  const executorPresentation =
    `https://chatgpt.com/g/g-p-other/c/${EXECUTOR_ID}`;

  const binding = await bindPlannerExecutorBridgePages(
    adapterWith([
      page("planner_page", PLANNER_URL),
      page("executor_page", EXECUTOR_URL)
    ]),
    {
      plannerUrl: plannerPresentation,
      executorUrl: executorPresentation
    }
  );

  assert.equal(binding.planner.chat_url, plannerPresentation);
  assert.equal(binding.planner.canonical_target, PLANNER_URL);
  assert.equal(binding.executor.canonical_target, EXECUTOR_URL);
});

test("Planner and Executor cannot point to the same canonical conversation", () => {
  assert.throws(
    () => validatePlannerExecutorBridgeUrls({
      plannerUrl: PLANNER_URL,
      executorUrl: `https://chatgpt.com/g/g-p-container/c/${PLANNER_ID}`
    }),
    (error) =>
      error instanceof ChatGptBridgeBindingError &&
      error.code === "DUPLICATE_ROLE_TARGET"
  );
});

test("missing exact role target fails closed instead of adopting another tab", async () => {
  await assert.rejects(
    () => bindPlannerExecutorBridgePages(
      adapterWith([
        page("planner_page", PLANNER_URL),
        page("other_page", `https://chatgpt.com/c/${OTHER_ID}`)
      ]),
      {
        plannerUrl: PLANNER_URL,
        executorUrl: EXECUTOR_URL
      }
    ),
    (error) =>
      error instanceof ChatGptBridgeBindingError &&
      error.code === "ROLE_TARGET_MISSING"
  );
});

test("duplicate live tabs for one role target are ambiguous and fail closed", async () => {
  await assert.rejects(
    () => bindPlannerExecutorBridgePages(
      adapterWith([
        page("planner_a", PLANNER_URL),
        page("planner_b", `https://chatgpt.com/g/g-p-x/c/${PLANNER_ID}`),
        page("executor_page", EXECUTOR_URL)
      ]),
      {
        plannerUrl: PLANNER_URL,
        executorUrl: EXECUTOR_URL,
        requireExactPageSet: false
      }
    ),
    (error) =>
      error instanceof ChatGptBridgeBindingError &&
      error.code === "ROLE_TARGET_AMBIGUOUS"
  );
});

test("distinct role URLs cannot resolve to one duplicated Bridge page_id", async () => {
  await assert.rejects(
    () => bindPlannerExecutorBridgePages(
      adapterWith([
        page("same_page", PLANNER_URL),
        page("same_page", EXECUTOR_URL)
      ]),
      {
        plannerUrl: PLANNER_URL,
        executorUrl: EXECUTOR_URL
      }
    ),
    (error) =>
      error instanceof ChatGptBridgeBindingError &&
      error.code === "DUPLICATE_ROLE_PAGE"
  );
});

test("unexpected unrelated live pages block the default exact two-page topology", async () => {
  await assert.rejects(
    () => bindPlannerExecutorBridgePages(
      adapterWith([
        page("planner_page", PLANNER_URL),
        page("executor_page", EXECUTOR_URL),
        page("other_page", `https://chatgpt.com/c/${OTHER_ID}`)
      ]),
      {
        plannerUrl: PLANNER_URL,
        executorUrl: EXECUTOR_URL
      }
    ),
    (error) =>
      error instanceof ChatGptBridgeBindingError &&
      error.code === "UNEXPECTED_BRIDGE_PAGES"
  );
});

test("stale unrelated pages are not adopted and do not block exact live topology", async () => {
  const binding = await bindPlannerExecutorBridgePages(
    adapterWith([
      page("planner_page", PLANNER_URL),
      page("executor_page", EXECUTOR_URL),
      page("stale_other", `https://chatgpt.com/c/${OTHER_ID}`, {
        alive: false
      })
    ]),
    {
      plannerUrl: PLANNER_URL,
      executorUrl: EXECUTOR_URL
    }
  );

  assert.equal(binding.page_count, 2);
  assert.equal(binding.exact_page_set, true);
});

test("optional non-exact mode reports unrelated pages but never adopts them", async () => {
  const binding = await bindPlannerExecutorBridgePages(
    adapterWith([
      page("planner_page", PLANNER_URL),
      page("executor_page", EXECUTOR_URL),
      page("other_page", `https://chatgpt.com/c/${OTHER_ID}`)
    ]),
    {
      plannerUrl: PLANNER_URL,
      executorUrl: EXECUTOR_URL,
      requireExactPageSet: false
    }
  );

  assert.equal(binding.planner.page_id, "planner_page");
  assert.equal(binding.executor.page_id, "executor_page");
  assert.equal(binding.exact_page_set, false);
  assert.deepEqual(binding.unrelated_page_ids, ["other_page"]);
});

test("reacquisition may change page_id after reload while preserving canonical role identity", async () => {
  const first = await bindPlannerExecutorBridgePages(
    adapterWith([
      page("planner_old", PLANNER_URL),
      page("executor_old", EXECUTOR_URL)
    ]),
    {
      plannerUrl: PLANNER_URL,
      executorUrl: EXECUTOR_URL
    }
  );

  const reacquired = await reacquirePlannerExecutorBridgePages(
    adapterWith([
      page("planner_new", PLANNER_URL),
      page("executor_old", EXECUTOR_URL)
    ]),
    first
  );

  assert.equal(reacquired.planner.page_id, "planner_new");
  assert.equal(reacquired.executor.page_id, "executor_old");
  assert.deepEqual(reacquired.reacquired, {
    planner: true,
    executor: false
  });
  assert.deepEqual(reacquired.previous_page_ids, {
    planner: "planner_old",
    executor: "executor_old"
  });
  assert.equal(reacquired.planner.canonical_target, first.planner.canonical_target);
});

test("binding validation rejects same page_id even when object is supplied directly", () => {
  assert.throws(
    () => validateBridgeRoleBinding({
      schema_version: CHATGPT_BRIDGE_BINDING_SCHEMA,
      planner: {
        page_id: "same",
        chat_url: PLANNER_URL,
        canonical_target: PLANNER_URL
      },
      executor: {
        page_id: "same",
        chat_url: EXECUTOR_URL,
        canonical_target: EXECUTOR_URL
      }
    }),
    (error) =>
      error instanceof ChatGptBridgeBindingError &&
      error.code === "DUPLICATE_ROLE_PAGE"
  );
});

test("invalid Owner ChatGPT URLs fail before Bridge enumeration", async () => {
  let listed = false;
  const adapter = {
    async listPages() {
      listed = true;
      return [];
    }
  };

  await assert.rejects(
    () => bindPlannerExecutorBridgePages(adapter, {
      plannerUrl: "https://example.com/not-chatgpt",
      executorUrl: EXECUTOR_URL
    }),
    (error) =>
      error instanceof ChatGptBridgeBindingError &&
      error.code === "INVALID_ROLE_URL"
  );
  assert.equal(listed, false);
});
