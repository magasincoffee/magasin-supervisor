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
  {
    plannerUrl,
    executorUrl,
    previousPlannerUrl = "",
    previousExecutorUrl = ""
  } = {}
) {
  if (!adapter) throw new TypeError("adapter is required");
  const targets = validatePlannerExecutorTargets(plannerUrl, executorUrl);

  const parsePrevious = (value) => {
    if (!value) return null;
    try {
      return targetFromUrl(String(value));
    } catch {
      return null;
    }
  };
  const previousTargets = [
    parsePrevious(previousPlannerUrl),
    parsePrevious(previousExecutorUrl)
  ].filter((target) =>
    target &&
    !sameTarget(target, targets.planner) &&
    !sameTarget(target, targets.executor)
  );

  await adapter.open();

  const acquireRolePage = async (url, target, previousTarget) => {
    const exact = adapter.findPageForTarget(target);
    if (exact) return exact;
    if (previousTarget && !sameTarget(previousTarget, target)) {
      const retiredPage = adapter.findPageForTarget(previousTarget);
      if (retiredPage) {
        const guarded = await adapter.hasNonPersistedComposerArtifact(retiredPage)
          .catch(() => true);
        if (guarded) {
          throw new Error(
            "superseded ChatGPT role tab contains a non-persisted composer artifact"
          );
        }
        await adapter.closePage(retiredPage);
      }
    }
    return adapter.reopenTargetPage(url);
  };

  const plannerPage = await acquireRolePage(
    plannerUrl,
    targets.planner,
    parsePrevious(previousPlannerUrl)
  );
  const executorPage = await acquireRolePage(
    executorUrl,
    targets.executor,
    parsePrevious(previousExecutorUrl)
  );

  if (plannerPage === executorPage) {
    throw new Error("Planner and Executor resolved to the same browser page");
  }

  // The forward runtime owns only two warm ChatGPT tabs. A conversation that
  // exactly matches a Supervisor-recorded superseded role target may be closed
  // after a draft guard; unrelated conversations still fail closed.
  for (const page of adapter.getChatGptPages()) {
    if (page === plannerPage || page === executorPage) continue;
    const pageUrl = page.url();
    const retired = previousTargets.some((target) =>
      pageMatchesTarget(pageUrl, target)
    );
    if (retired) {
      const guarded = await adapter.hasNonPersistedComposerArtifact(page)
        .catch(() => true);
      if (guarded) {
        throw new Error(
          "superseded ChatGPT role tab contains a non-persisted composer artifact"
        );
      }
      await adapter.closePage(page);
      continue;
    }
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

export function assertPlannerExecutorWarmTabs(
  adapter,
  { plannerPage, executorPage, plannerTarget, executorTarget } = {}
) {
  if (!plannerPage || !executorPage) {
    throw new Error("Planner and Executor warm pages are required");
  }
  if (plannerPage.isClosed?.() || executorPage.isClosed?.()) {
    throw new Error("Planner or Executor warm tab was closed");
  }
  const pages = adapter.getChatGptPages();
  if (pages.length !== 2) {
    throw new Error(`warm runtime topology drifted from 2 ChatGPT tabs to ${pages.length}`);
  }
  if (
    !pageMatchesTarget(plannerPage.url(), plannerTarget) ||
    !pageMatchesTarget(executorPage.url(), executorTarget)
  ) {
    throw new Error("Planner/Executor warm target identity drift");
  }
  return true;
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
