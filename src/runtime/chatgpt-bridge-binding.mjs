import {
  pageMatchesTarget,
  targetFromUrl
} from "./recovery.mjs";
import { ChatGptBridgeError } from "./chatgpt-bridge-adapter.mjs";

export const CHATGPT_BRIDGE_BINDING_SCHEMA = "chatgpt-bridge-binding.v1";

export class ChatGptBridgeBindingError extends Error {
  constructor(message, {
    code = "BRIDGE_BINDING_ERROR",
    details = null,
    cause = null
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ChatGptBridgeBindingError";
    this.code = code;
    this.details = details;
  }
}

function canonicalTarget(value, role) {
  try {
    return targetFromUrl(String(value || ""));
  } catch (error) {
    throw new ChatGptBridgeBindingError(
      `${role} ChatGPT conversation URL is invalid`,
      {
        code: "INVALID_ROLE_URL",
        cause: error,
        details: { role }
      }
    );
  }
}

function sameTarget(a, b) {
  return Boolean(
    a &&
    b &&
    a.origin === b.origin &&
    a.pathname === b.pathname
  );
}

function canonicalTargetUrl(target) {
  return target.origin + target.pathname;
}

function requireAdapter(adapter) {
  if (!adapter || typeof adapter.listPages !== "function") {
    throw new ChatGptBridgeBindingError("Bridge adapter with listPages() is required", {
      code: "INVALID_ADAPTER"
    });
  }
  return adapter;
}

function normalizedPage(page) {
  if (
    !page ||
    typeof page !== "object" ||
    !String(page.page_id || "").trim()
  ) {
    throw new ChatGptBridgeBindingError("Bridge returned a malformed page summary", {
      code: "MALFORMED_PAGE"
    });
  }
  return {
    page_id: String(page.page_id).trim(),
    url: String(page.url || ""),
    title: String(page.title || ""),
    alive: Boolean(page.alive),
    is_generating: Boolean(page.is_generating)
  };
}

function alivePages(values) {
  if (!Array.isArray(values)) {
    throw new ChatGptBridgeBindingError("Bridge page list must be an array", {
      code: "MALFORMED_PAGE_LIST"
    });
  }
  return values.map(normalizedPage).filter((page) => page.alive);
}

function exactMatches(pages, target) {
  return pages.filter((page) => pageMatchesTarget(page.url, target));
}

function resolveRole(pages, target, role) {
  const matches = exactMatches(pages, target);
  if (matches.length === 0) {
    throw new ChatGptBridgeBindingError(
      `${role} target is not connected to the Bridge`,
      {
        code: "ROLE_TARGET_MISSING",
        details: {
          role,
          canonical_target: canonicalTargetUrl(target)
        }
      }
    );
  }
  if (matches.length > 1) {
    throw new ChatGptBridgeBindingError(
      `${role} target resolves to multiple live Bridge pages`,
      {
        code: "ROLE_TARGET_AMBIGUOUS",
        details: {
          role,
          canonical_target: canonicalTargetUrl(target),
          page_ids: matches.map((page) => page.page_id)
        }
      }
    );
  }
  return matches[0];
}

export function validatePlannerExecutorBridgeUrls({
  plannerUrl,
  executorUrl
} = {}) {
  const plannerTarget = canonicalTarget(plannerUrl, "Planner");
  const executorTarget = canonicalTarget(executorUrl, "Executor");
  if (sameTarget(plannerTarget, executorTarget)) {
    throw new ChatGptBridgeBindingError(
      "Planner and Executor must be different ChatGPT conversations",
      { code: "DUPLICATE_ROLE_TARGET" }
    );
  }
  return {
    plannerTarget,
    executorTarget
  };
}

export function validateBridgeRoleBinding(binding) {
  if (
    !binding ||
    binding.schema_version !== CHATGPT_BRIDGE_BINDING_SCHEMA
  ) {
    throw new ChatGptBridgeBindingError("Unsupported Bridge binding schema", {
      code: "INVALID_BINDING"
    });
  }

  const planner = binding.planner;
  const executor = binding.executor;
  for (const [role, value] of [
    ["Planner", planner],
    ["Executor", executor]
  ]) {
    if (
      !value ||
      !String(value.page_id || "").trim() ||
      !String(value.chat_url || "").trim() ||
      !String(value.canonical_target || "").trim()
    ) {
      throw new ChatGptBridgeBindingError(
        `${role} Bridge binding is incomplete`,
        { code: "INVALID_BINDING" }
      );
    }
  }

  if (planner.page_id === executor.page_id) {
    throw new ChatGptBridgeBindingError(
      "Planner and Executor cannot share one Bridge page_id",
      { code: "DUPLICATE_ROLE_PAGE" }
    );
  }

  const plannerTarget = canonicalTarget(planner.canonical_target, "Planner");
  const executorTarget = canonicalTarget(executor.canonical_target, "Executor");
  if (sameTarget(plannerTarget, executorTarget)) {
    throw new ChatGptBridgeBindingError(
      "Planner and Executor binding targets overlap",
      { code: "DUPLICATE_ROLE_TARGET" }
    );
  }

  return binding;
}

export async function bindPlannerExecutorBridgePages(
  adapter,
  {
    plannerUrl,
    executorUrl,
    requireExactPageSet = true
  } = {}
) {
  requireAdapter(adapter);
  const { plannerTarget, executorTarget } =
    validatePlannerExecutorBridgeUrls({ plannerUrl, executorUrl });

  let rawPages;
  try {
    rawPages = await adapter.listPages();
  } catch (error) {
    if (error instanceof ChatGptBridgeError) throw error;
    throw new ChatGptBridgeBindingError("Failed to enumerate Bridge pages", {
      code: "PAGE_ENUMERATION_FAILED",
      cause: error
    });
  }

  const pages = alivePages(rawPages);
  const plannerPage = resolveRole(pages, plannerTarget, "Planner");
  const executorPage = resolveRole(pages, executorTarget, "Executor");

  if (plannerPage.page_id === executorPage.page_id) {
    throw new ChatGptBridgeBindingError(
      "Planner and Executor resolved to the same Bridge page_id",
      { code: "DUPLICATE_ROLE_PAGE" }
    );
  }

  const targetIds = new Set([plannerPage.page_id, executorPage.page_id]);
  const unrelated = pages.filter((page) => !targetIds.has(page.page_id));
  if (requireExactPageSet && unrelated.length > 0) {
    throw new ChatGptBridgeBindingError(
      "Unexpected live Bridge pages block exact Planner/Executor topology",
      {
        code: "UNEXPECTED_BRIDGE_PAGES",
        details: {
          unrelated_page_ids: unrelated.map((page) => page.page_id)
        }
      }
    );
  }

  const binding = {
    schema_version: CHATGPT_BRIDGE_BINDING_SCHEMA,
    page_count: pages.length,
    exact_page_set: unrelated.length === 0,
    planner: {
      role: "planner",
      chat_url: String(plannerUrl).trim(),
      canonical_target: canonicalTargetUrl(plannerTarget),
      page_id: plannerPage.page_id,
      page_url: plannerPage.url,
      title: plannerPage.title
    },
    executor: {
      role: "executor",
      chat_url: String(executorUrl).trim(),
      canonical_target: canonicalTargetUrl(executorTarget),
      page_id: executorPage.page_id,
      page_url: executorPage.url,
      title: executorPage.title
    },
    unrelated_page_ids: unrelated.map((page) => page.page_id)
  };

  return validateBridgeRoleBinding(binding);
}

function assertSameRoleTarget(previous, current, role) {
  const previousTarget = canonicalTarget(previous?.canonical_target, role);
  const currentTarget = canonicalTarget(current?.canonical_target, role);
  if (!sameTarget(previousTarget, currentTarget)) {
    throw new ChatGptBridgeBindingError(
      `${role} reacquisition changed canonical conversation identity`,
      {
        code: "ROLE_IDENTITY_CHANGED",
        details: {
          role,
          previous_target: canonicalTargetUrl(previousTarget),
          current_target: canonicalTargetUrl(currentTarget)
        }
      }
    );
  }
}

export async function reacquirePlannerExecutorBridgePages(
  adapter,
  previousBinding,
  {
    requireExactPageSet = true
  } = {}
) {
  const previous = validateBridgeRoleBinding(previousBinding);
  const current = await bindPlannerExecutorBridgePages(adapter, {
    plannerUrl: previous.planner.chat_url,
    executorUrl: previous.executor.chat_url,
    requireExactPageSet
  });

  assertSameRoleTarget(previous.planner, current.planner, "Planner");
  assertSameRoleTarget(previous.executor, current.executor, "Executor");

  return {
    ...current,
    reacquired: {
      planner: previous.planner.page_id !== current.planner.page_id,
      executor: previous.executor.page_id !== current.executor.page_id
    },
    previous_page_ids: {
      planner: previous.planner.page_id,
      executor: previous.executor.page_id
    }
  };
}
