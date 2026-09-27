import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  acquirePlannerExecutorWarmTabs,
  assertPlannerExecutorWarmTabs,
  createIdleAwareTurnCapture,
  expectedWaitRole,
  validatePlannerExecutorTargets
} from "../src/runtime/planner-executor-session.mjs";

function fakePage(url, { draft = false } = {}) {
  let closed = false;
  return {
    url() { return url; },
    isClosed() { return closed; },
    async close() { closed = true; },
    async waitForTimeout() {},
    draft
  };
}

function makeAdapter(pages, plannerPage, executorPage) {
  return {
    opened: false,
    async open() { this.opened = true; return pages[0] || null; },
    getChatGptPages() { return pages.filter((page) => !page.isClosed()); },
    findPageForTarget(target) {
      return this.getChatGptPages().find((page) => {
        const url = new URL(page.url());
        return url.origin === target.origin && url.pathname === target.pathname;
      }) || null;
    },
    async reopenTargetPage(url) {
      if (url.includes("planner")) return plannerPage;
      if (url.includes("executor")) return executorPage;
      throw new Error("unexpected target");
    },
    async hasNonPersistedComposerArtifact(page) { return Boolean(page.draft); },
    async closePage(page) { await page.close(); return true; },
    async probePage() {
      return {
        snapshot: {
          loginRequired: false,
          hasCaptcha: false,
          conversationAccessDenied: false,
          conversationMissing: false,
          responseRunning: false,
          assistantBusy: false
        }
      };
    }
  };
}

test("PE-003 target validation requires two distinct normal ChatGPT conversations", () => {
  const planner = "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111";
  const executor = "https://chatgpt.com/c/22222222-2222-2222-2222-222222222222";
  const targets = validatePlannerExecutorTargets(planner, executor);
  assert.equal(targets.planner.pathname, "/c/11111111-1111-1111-1111-111111111111");
  assert.equal(targets.executor.pathname, "/c/22222222-2222-2222-2222-222222222222");

  assert.throws(
    () => validatePlannerExecutorTargets(planner, planner),
    /different ChatGPT conversations/
  );
});

test("PE-003 warm acquisition keeps exact Planner + Executor and deletes only safe blank landing tab", async () => {
  const plannerUrl = "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111";
  const executorUrl = "https://chatgpt.com/c/22222222-2222-2222-2222-222222222222";
  const plannerPage = fakePage(plannerUrl);
  const executorPage = fakePage(executorUrl);
  const blank = fakePage("https://chatgpt.com/");
  const pages = [blank, plannerPage, executorPage];
  const adapter = makeAdapter(pages, plannerPage, executorPage);

  const warm = await acquirePlannerExecutorWarmTabs(adapter, {
    plannerUrl,
    executorUrl
  });

  assert.equal(adapter.opened, true);
  assert.equal(blank.isClosed(), true);
  assert.equal(warm.pageCount, 2);
  assert.equal(adapter.getChatGptPages().length, 2);
  assert.equal(
    assertPlannerExecutorWarmTabs(adapter, warm),
    true
  );
});

test("PE-003 refuses to close an unrelated extra conversation or a blank tab with draft", async () => {
  const plannerUrl = "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111";
  const executorUrl = "https://chatgpt.com/c/22222222-2222-2222-2222-222222222222";
  const plannerPage = fakePage(plannerUrl);
  const executorPage = fakePage(executorUrl);
  const foreign = fakePage("https://chatgpt.com/c/33333333-3333-3333-3333-333333333333");
  const adapter = makeAdapter([plannerPage, executorPage, foreign], plannerPage, executorPage);

  await assert.rejects(
    acquirePlannerExecutorWarmTabs(adapter, { plannerUrl, executorUrl }),
    /unexpected extra ChatGPT conversation/
  );
  assert.equal(foreign.isClosed(), false);

  const guardedBlank = fakePage("https://chatgpt.com/", { draft: true });
  const adapter2 = makeAdapter(
    [plannerPage, executorPage, guardedBlank],
    plannerPage,
    executorPage
  );
  await assert.rejects(
    acquirePlannerExecutorWarmTabs(adapter2, { plannerUrl, executorUrl }),
    /non-persisted composer artifact/
  );
  assert.equal(guardedBlank.isClosed(), false);
});

test("chat target rollover retires only the exact superseded role tab and keeps two-tab topology", async () => {
  const oldPlannerUrl = "https://chatgpt.com/c/old-planner";
  const newPlannerUrl = "https://chatgpt.com/c/new-planner";
  const executorUrl = "https://chatgpt.com/c/executor-current";
  const oldPlannerPage = fakePage(oldPlannerUrl);
  const newPlannerPage = fakePage(newPlannerUrl);
  const executorPage = fakePage(executorUrl);
  const pages = [oldPlannerPage, executorPage];

  const adapter = {
    async open() { return oldPlannerPage; },
    getChatGptPages() { return pages.filter((page) => !page.isClosed()); },
    findPageForTarget(target) {
      return this.getChatGptPages().find((page) => {
        const url = new URL(page.url());
        return url.origin === target.origin && url.pathname === target.pathname;
      }) || null;
    },
    async reopenTargetPage(url) {
      if (url === newPlannerUrl) {
        pages.push(newPlannerPage);
        return newPlannerPage;
      }
      throw new Error("unexpected reopen");
    },
    async hasNonPersistedComposerArtifact(page) { return Boolean(page.draft); },
    async closePage(page) { await page.close(); return true; },
    async probePage() {
      return {
        snapshot: {
          loginRequired: false,
          hasCaptcha: false,
          conversationAccessDenied: false,
          conversationMissing: false,
          responseRunning: false,
          assistantBusy: false
        }
      };
    }
  };

  const warm = await acquirePlannerExecutorWarmTabs(adapter, {
    plannerUrl: newPlannerUrl,
    executorUrl,
    previousPlannerUrl: oldPlannerUrl
  });

  assert.equal(oldPlannerPage.isClosed(), true);
  assert.equal(warm.plannerPage, newPlannerPage);
  assert.equal(warm.executorPage, executorPage);
  assert.equal(adapter.getChatGptPages().length, 2);
});

test("chat target rollover preserves a superseded role tab when it contains an unsent draft", async () => {
  const oldPlannerUrl = "https://chatgpt.com/c/old-planner-draft";
  const newPlannerUrl = "https://chatgpt.com/c/new-planner-draft";
  const executorUrl = "https://chatgpt.com/c/executor-current-draft";
  const oldPlannerPage = fakePage(oldPlannerUrl, { draft: true });
  const executorPage = fakePage(executorUrl);
  const newPlannerPage = fakePage(newPlannerUrl);
  const pages = [oldPlannerPage, executorPage];

  const adapter = {
    async open() { return oldPlannerPage; },
    getChatGptPages() { return pages.filter((page) => !page.isClosed()); },
    findPageForTarget(target) {
      return this.getChatGptPages().find((page) => {
        const url = new URL(page.url());
        return url.origin === target.origin && url.pathname === target.pathname;
      }) || null;
    },
    async reopenTargetPage() {
      pages.push(newPlannerPage);
      return newPlannerPage;
    },
    async hasNonPersistedComposerArtifact(page) { return Boolean(page.draft); },
    async closePage(page) { await page.close(); return true; },
    async probePage() { return { snapshot: {} }; }
  };

  await assert.rejects(
    acquirePlannerExecutorWarmTabs(adapter, {
      plannerUrl: newPlannerUrl,
      executorUrl,
      previousPlannerUrl: oldPlannerUrl
    }),
    /superseded ChatGPT role tab contains a non-persisted composer artifact/
  );
  assert.equal(oldPlannerPage.isClosed(), false);
});

test("PE-003 topology guard fails closed on page-count or identity drift", () => {
  const plannerUrl = "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111";
  const executorUrl = "https://chatgpt.com/c/22222222-2222-2222-2222-222222222222";
  const plannerPage = fakePage(plannerUrl);
  const executorPage = fakePage(executorUrl);
  const extra = fakePage("https://chatgpt.com/");
  const targets = validatePlannerExecutorTargets(plannerUrl, executorUrl);

  const adapter = {
    getChatGptPages() { return [plannerPage, executorPage, extra]; }
  };
  assert.throws(
    () => assertPlannerExecutorWarmTabs(adapter, {
      plannerPage,
      executorPage,
      plannerTarget: targets.planner,
      executorTarget: targets.executor
    }),
    /topology drifted/
  );

  const adapter2 = { getChatGptPages() { return [plannerPage, executorPage]; } };
  assert.throws(
    () => assertPlannerExecutorWarmTabs(adapter2, {
      plannerPage,
      executorPage,
      plannerTarget: targets.executor,
      executorTarget: targets.planner
    }),
    /identity drift/
  );
});

test("PE-003 assistant capture waits while ChatGPT is busy but user-turn recovery stays readable", async () => {
  let busy = true;
  let captures = 0;
  const adapter = {
    async probePage() {
      return { snapshot: { responseRunning: busy, assistantBusy: busy } };
    }
  };
  const capture = createIdleAwareTurnCapture(
    adapter,
    async (_page, role) => {
      captures += 1;
      return { role, turn_id: role + ":1", text: "x" };
    }
  );

  assert.equal(await capture({}, "assistant"), null);
  assert.equal(captures, 0);

  const user = await capture({}, "user");
  assert.equal(user.role, "user");
  assert.equal(captures, 1);

  busy = false;
  const assistant = await capture({}, "assistant");
  assert.equal(assistant.role, "assistant");
  assert.equal(captures, 2);
});

test("PE-003 phase routing keeps the two warm tabs sticky", () => {
  assert.equal(expectedWaitRole("WAIT_PLANNER_ASSIGN"), "planner");
  assert.equal(expectedWaitRole("WAIT_PLANNER_DECISION"), "planner");
  assert.equal(expectedWaitRole("WAIT_EXECUTOR_REPORT"), "executor");
  assert.equal(expectedWaitRole("PLANNER_ASSIGN"), null);
});

test("PE-003 forward CLI is a two-tab runtime with no Three-Lane scheduler dependency", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/planner-executor-cli.mjs", import.meta.url),
    "utf8"
  );
  const session = await fs.readFile(
    new URL("../src/runtime/planner-executor-session.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /PLANNER_EXECUTOR_V1/);
  assert.match(source, /PLANNER_EXECUTOR_CHATGPT_TABS/);
  assert.match(source, /CHATGPT_WORK_MODE_INVOCATIONS", 0/);
  assert.match(source, /production_cutover: false/);
  assert.match(source, /assertPlannerExecutorWarmTabs/);
  assert.match(source, /previousPlannerUrl/);
  assert.match(source, /PLANNER_EXECUTOR_CHAT_TARGET_ROLLOVER/);
  assert.match(session, /previousPlannerUrl/);
  assert.match(session, /superseded ChatGPT role tab/);
  assert.match(session, /pages\.length !== 2/);

  assert.doesNotMatch(source, /browser-scheduler/i);
  assert.doesNotMatch(source, /three-lane/i);
  assert.doesNotMatch(session, /browser-scheduler/i);
  assert.doesNotMatch(session, /three-lane/i);
});

test("PE-003 runtime modules pass Node syntax checks", () => {
  for (const relative of [
    "../src/runtime/planner-executor-session.mjs",
    "../src/runtime/planner-executor-cli.mjs"
  ]) {
    const scriptPath = fileURLToPath(new URL(relative, import.meta.url));
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ["--check", scriptPath], { stdio: "pipe" });
    });
  }
});
