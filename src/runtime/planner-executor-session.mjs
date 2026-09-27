import { isChatGptUrl } from "../ui/playwright-adapter.mjs";
import { targetFromUrl, pageMatchesTarget } from "./recovery.mjs";

function sameTarget(a, b) {
  return a?.origin === b?.origin && a?.pathname === b?.pathname;
}

function isBlankChatGptPage(page) {
  try {
    const url = new URL(page.url());
    return isChatGptUrl(url.toString()) &&
      (url.pathname === "/" || url.pathname === "") &&
      !url.search;
  } catch {
    return false;
  }
}

export function validatePlannerExecutorTargets(plannerUrl, executorUrl) {
  const planner = targetFromUrl(String(plannerUrl || ""));
  const executor = targetFromUrl(String(executorUrl || ""));
  if (sameTarget(planner, executor)) {
    throw new Error("Planner and Executor must be different ChatGPT conversations");
  }
  return { planner, executor };
}

export async function acquirePlannerExecutorWarmTabs(
  adapter,
  { plannerUrl, executorUrl } = {}
) {
  if (!adapter) throw new TypeError("adapter is required");
  const targets = validatePlannerExecutorTargets(plannerUrl, executorUrl);

  await adapter.open();

  const plannerPage =
    adapter.findPageForTarget(targets.planner) ||
    await adapter.reopenTargetPage(plannerUrl);
  const executorPage =
    adapter.findPageForTarget(targets.executor) ||
    await adapter.reopenTargetPage(executorUrl);

  if (plannerPage === executorPage) {
    throw new Error("Planner and Executor resolved to the same browser page");
  }

  // The forward runtime owns only two warm ChatGPT tabs. Remove only an empty
  // landing tab with no draft; never close an unrelated conversation.
  for (const page of adapter.getChatGptPages()) {
    if (page === plannerPage || page === executorPage) continue;
    if (!isBlankChatGptPage(page)) {
      throw new Error(
        "unexpected extra ChatGPT conversation blocks exact two-tab topology"
      );
    }
    const guarded = await adapter.hasNonPersistedComposerArtifact(page)
      .catch(() => true);
    if (guarded) {
      throw new Error(
        "blank extra ChatGPT tab contains a non-persisted composer artifact"
      );
    }
    await adapter.closePage(page);
  }

  const pages = adapter.getChatGptPages();
  if (pages.length !== 2) {
    throw new Error(`expected exactly 2 warm ChatGPT tabs, found ${pages.length}`);
  }
  if (
    !pageMatchesTarget(plannerPage.url(), targets.planner) ||
    !pageMatchesTarget(executorPage.url(), targets.executor)
  ) {
    throw new Error("warm tab target identity mismatch");
  }

  const plannerProbe = await adapter.probePage(plannerPage);
  const executorProbe = await adapter.probePage(executorPage);
  for (const [role, probe] of [
    ["Planner", plannerProbe],
    ["Executor", executorProbe]
  ]) {
    if (
      probe?.snapshot?.loginRequired ||
      probe?.snapshot?.hasCaptcha ||
      probe?.snapshot?.conversationAccessDenied ||
      probe?.snapshot?.conversationMissing
    ) {
      throw new Error(`${role} target is not safely accessible`);
    }
  }

  return {
    plannerPage,
    executorPage,
    pageCount: 2,
    plannerTarget: targets.planner,
    executorTarget: targets.executor
  };
}

export function expectedWaitRole(phase) {
  const value = String(phase || "");
  if (value.startsWith("WAIT_EXECUTOR")) return "executor";
  if (value.startsWith("WAIT_PLANNER")) return "planner";
  return null;
}

export function createIdleAwareTurnCapture(adapter, captureTurn) {
  if (!adapter) throw new TypeError("adapter is required");
  if (typeof captureTurn !== "function") {
    throw new TypeError("captureTurn is required");
  }

  return async (page, role) => {
    if (role === "assistant") {
      const probe = await adapter.probePage(page).catch(() => null);
      if (
        !probe ||
        probe.snapshot?.responseRunning ||
        probe.snapshot?.assistantBusy
      ) {
        return null;
      }
    }
    return captureTurn(page, role);
  };
}
