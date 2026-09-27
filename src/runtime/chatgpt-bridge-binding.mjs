import {
  ChatGptBridgeError
} from "./chatgpt-bridge-adapter.mjs";

const CHATGPT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);

function normalizeConversationUrl(value, label) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch (error) {
    throw new ChatGptBridgeError(label + " is not a valid URL", {
      code: "INVALID_CHAT_TARGET_URL",
      cause: error
    });
  }

  if (url.protocol !== "https:" || !CHATGPT_HOSTS.has(url.hostname)) {
    throw new ChatGptBridgeError(label + " must be a ChatGPT HTTPS URL", {
      code: "INVALID_CHAT_TARGET_URL"
    });
  }

  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return {
    origin: url.origin,
    pathname,
    canonical_url: url.origin + pathname
  };
}

function sameTarget(a, b) {
  return a.origin === b.origin && a.pathname === b.pathname;
}

async function inspectAliveBridgePages(adapter) {
  const pages = await adapter.listPages();
  const alive = pages.filter((page) => page.alive === true);
  const inspected = [];

  for (const page of alive) {
    const snapshot = await adapter.getSnapshot(page.page_id);
    let target = null;
    try {
      target = normalizeConversationUrl(snapshot.url || page.url, "Bridge page URL");
    } catch {
      continue;
    }
    inspected.push({
      page_id: page.page_id,
      summary: page,
      snapshot,
      target
    });
  }

  return inspected;
}

function selectExactRolePage(role, target, inspected) {
  const matches = inspected.filter((page) => sameTarget(page.target, target));

  if (matches.length === 0) {
    throw new ChatGptBridgeError(role + " ChatGPT target is not connected to the Bridge", {
      code: "ROLE_TARGET_NOT_FOUND",
      details: { role, canonical_url: target.canonical_url }
    });
  }

  if (matches.length > 1) {
    throw new ChatGptBridgeError(role + " ChatGPT target is ambiguous across multiple Bridge pages", {
      code: "ROLE_TARGET_AMBIGUOUS",
      details: {
        role,
        canonical_url: target.canonical_url,
        match_count: matches.length
      }
    });
  }

  return matches[0];
}

export function normalizeBridgeRoleTargets({
  plannerUrl,
  executorUrl
} = {}) {
  const planner = normalizeConversationUrl(plannerUrl, "Planner URL");
  const executor = normalizeConversationUrl(executorUrl, "Executor URL");

  if (sameTarget(planner, executor)) {
    throw new ChatGptBridgeError(
      "Planner and Executor must be different ChatGPT conversations",
      { code: "ROLE_TARGET_COLLISION" }
    );
  }

  return { planner, executor };
}

export async function bindPlannerExecutorBridgePages(
  adapter,
  {
    plannerUrl,
    executorUrl,
    plannerTargetRevision = 1,
    executorTargetRevision = 1
  } = {}
) {
  if (!adapter || typeof adapter.listPages !== "function" || typeof adapter.getSnapshot !== "function") {
    throw new ChatGptBridgeError("Bridge adapter with listPages/getSnapshot is required", {
      code: "INVALID_ARGUMENT"
    });
  }

  const targets = normalizeBridgeRoleTargets({ plannerUrl, executorUrl });
  const inspected = await inspectAliveBridgePages(adapter);

  const planner = selectExactRolePage("Planner", targets.planner, inspected);
  const executor = selectExactRolePage("Executor", targets.executor, inspected);

  if (planner.page_id === executor.page_id) {
    throw new ChatGptBridgeError(
      "Planner and Executor resolved to the same Bridge page_id",
      { code: "ROLE_PAGE_COLLISION" }
    );
  }

  return {
    planner: {
      role: "planner",
      chat_url: targets.planner.canonical_url,
      page_id: planner.page_id,
      target_revision: Number(plannerTargetRevision) || 1
    },
    executor: {
      role: "executor",
      chat_url: targets.executor.canonical_url,
      page_id: executor.page_id,
      target_revision: Number(executorTargetRevision) || 1
    },
    observed_page_count: inspected.length
  };
}

export async function reacquireBridgeRoleBinding(
  adapter,
  binding,
  {
    plannerUrl = binding?.planner?.chat_url,
    executorUrl = binding?.executor?.chat_url
  } = {}
) {
  if (!binding?.planner || !binding?.executor) {
    throw new ChatGptBridgeError("Existing role binding is required for reacquisition", {
      code: "INVALID_BINDING"
    });
  }

  return bindPlannerExecutorBridgePages(adapter, {
    plannerUrl,
    executorUrl,
    plannerTargetRevision: binding.planner.target_revision,
    executorTargetRevision: binding.executor.target_revision
  });
}
