import crypto from "node:crypto";

import {
  acquirePlannerExecutorWarmTabs,
  assertPlannerExecutorWarmTabs,
  recoverPlannerExecutorWarmTabs
} from "./planner-executor-session.mjs";
import {
  bindPlannerExecutorBridgePages
} from "./chatgpt-bridge-binding.mjs";

export const MAGASIN_BRIDGE_USERSCRIPT_PATCH = "MAGASIN_BRIDGE_USERSCRIPT_PATCH_V1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export function patchPinnedBridgeUserscript(source) {
  let text = String(source || "");
  if (!text.includes("ChatGPT Bridge") && !text.includes("AI WebUI Bridge")) {
    throw new Error("Pinned Bridge userscript source is invalid");
  }
  // Preserve upstream transport behavior while widening observation payloads so
  // MAGASIN never truncates @M bodies/evidence merely because upstream's demo
  // monitor prefers short previews.
  text = text
    .replaceAll(".slice(-600)", ".slice(-12000)")
    .replaceAll(".slice(-1000)", ".slice(-20000)")
    .replaceAll(".slice(0, 200)", ".slice(0, 12000)");
  return [
    "globalThis.__MAGASIN_BRIDGE_PATCH__ = " + JSON.stringify(MAGASIN_BRIDGE_USERSCRIPT_PATCH) + ";",
    text
  ].join("\n");
}

async function ensureGmShim(page, bindingName) {
  try {
    await page.exposeFunction(bindingName, async (request) => {
      const response = await fetch(String(request.url), {
        method: request.method || "GET",
        headers: request.headers || {},
        body: request.body || undefined,
        signal: AbortSignal.timeout(15_000)
      });
      return {
        status: response.status,
        responseText: await response.text()
      };
    });
  } catch (error) {
    // Playwright keeps exposed bindings across same-page navigations. A second
    // install on the same Page may report that the binding already exists.
    if (!/already|registered|exists/i.test(String(error?.message || error))) {
      throw error;
    }
  }

  await page.evaluate((name) => {
    const invoke = globalThis[name];
    if (typeof invoke !== "function") {
      throw new Error("MAGASIN Bridge HTTP binding is unavailable");
    }
    globalThis.GM_xmlhttpRequest = (opts) => {
      invoke({
        method: opts.method || "GET",
        url: opts.url,
        headers: opts.headers || {},
        body: opts.data
      }).then((result) => {
        opts.onload?.({
          status: result.status,
          responseText: result.responseText
        });
      }).catch((error) => {
        opts.onerror?.({ error: String(error?.message || error) });
      });
    };
    globalThis.GM = { xmlHttpRequest: globalThis.GM_xmlhttpRequest };
  }, bindingName);
}

export async function injectPinnedBridgeUserscript(page, source, {
  bindingName = "__magasinBridgeHttp"
} = {}) {
  if (!page || typeof page.evaluate !== "function") {
    throw new TypeError("Playwright page is required");
  }
  await ensureGmShim(page, bindingName);
  const patched = patchPinnedBridgeUserscript(source);
  await page.evaluate((script) => {
    // Runtime injection is intentionally the pinned upstream userscript plus
    // MAGASIN's bounded observation-length patch. Message actuation remains
    // upstream Bridge behavior, not Supervisor's legacy sendComposerInstruction.
    (0, eval)(script);
  }, patched);
  return {
    patch: MAGASIN_BRIDGE_USERSCRIPT_PATCH,
    source_digest: hash(source),
    patched_digest: hash(patched)
  };
}

async function waitForBinding(bridgeAdapter, options, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      return await bindPlannerExecutorBridgePages(bridgeAdapter, options);
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }
  throw lastError || new Error("Bridge role binding timed out");
}

export async function prepareBridgeBrowserRuntime({
  browserAdapter,
  bridgeAdapter,
  plannerUrl,
  executorUrl,
  userscriptSource,
  previousPlannerUrl = "",
  previousExecutorUrl = "",
  requireExactPageSet = true
} = {}) {
  if (!browserAdapter || !bridgeAdapter) {
    throw new TypeError("browserAdapter and bridgeAdapter are required");
  }

  let warm = await acquirePlannerExecutorWarmTabs(browserAdapter, {
    plannerUrl,
    executorUrl,
    previousPlannerUrl,
    previousExecutorUrl
  });

  const bindingName = "__magasinBridgeHttp_" +
    crypto.randomBytes(6).toString("hex");

  // Reload once at process startup to remove any orphaned polling loop/binding
  // left by a previous Bridge CLI process. Conversation identity is preserved.
  await Promise.all([
    warm.plannerPage.reload({ waitUntil: "domcontentloaded" }),
    warm.executorPage.reload({ waitUntil: "domcontentloaded" })
  ]);

  const injections = await Promise.all([
    injectPinnedBridgeUserscript(warm.plannerPage, userscriptSource, { bindingName }),
    injectPinnedBridgeUserscript(warm.executorPage, userscriptSource, { bindingName })
  ]);

  let binding = await waitForBinding(bridgeAdapter, {
    plannerUrl,
    executorUrl,
    requireExactPageSet
  });

  async function recover() {
    warm = await recoverPlannerExecutorWarmTabs(browserAdapter, {
      plannerUrl,
      executorUrl,
      attempts: 3
    });
    assertPlannerExecutorWarmTabs(browserAdapter, warm);

    // A page reload/navigation destroys page JavaScript but exposed Playwright
    // bindings survive. Reinstall the GM shim + pinned userscript only when the
    // Bridge no longer reports the exact target.
    try {
      binding = await bindPlannerExecutorBridgePages(bridgeAdapter, {
        plannerUrl,
        executorUrl,
        requireExactPageSet
      });
      return { warm, binding, reinjected: false };
    } catch {
      await Promise.all([
        injectPinnedBridgeUserscript(warm.plannerPage, userscriptSource, { bindingName }),
        injectPinnedBridgeUserscript(warm.executorPage, userscriptSource, { bindingName })
      ]);
      binding = await waitForBinding(bridgeAdapter, {
        plannerUrl,
        executorUrl,
        requireExactPageSet
      });
      return { warm, binding, reinjected: true };
    }
  }

  return {
    get warm() { return warm; },
    get binding() { return binding; },
    bindingName,
    injections,
    recover
  };
}
