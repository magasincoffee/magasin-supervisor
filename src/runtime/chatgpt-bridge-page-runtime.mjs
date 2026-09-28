import crypto from "node:crypto";

import {
  acquirePlannerExecutorWarmTabs,
  assertPlannerExecutorWarmTabs
} from "./planner-executor-session.mjs";
import {
  recoverPlannerExecutorWarmTabs
} from "./planner-executor-automation.mjs";
import {
  bindPlannerExecutorBridgePages,
  CHATGPT_BRIDGE_MANAGED_PAGE_SUFFIX
} from "./chatgpt-bridge-binding.mjs";

export const MAGASIN_BRIDGE_USERSCRIPT_PATCH = "MAGASIN_BRIDGE_USERSCRIPT_PATCH_V1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export function patchPinnedBridgeUserscript(source) {
  // Git for Windows may materialize the pinned upstream userscript with CRLF.
  // Normalize before applying exact multi-line patches so snapshot/last-reply
  // replacements cannot silently miss while single-line patches still apply.
  let text = String(source || "").replace(/\r\n?/g, "\n");
  if (!text.includes("ChatGPT Bridge") && !text.includes("AI WebUI Bridge")) {
    throw new Error("Pinned Bridge userscript source is invalid");
  }
  // Preserve upstream transport behavior while widening observation payloads so
  // MAGASIN never truncates @M bodies/evidence merely because upstream's demo
  // monitor prefers short previews.
  text = text
    .replaceAll(".slice(-600)", ".slice(-12000)")
    .replaceAll(".slice(-1000)", ".slice(-20000)")
    .replaceAll(".slice(0, 200)", ".slice(0, 12000)")
    .replace(
      "  const PAGE_ID = genPageId();",
      "  const PAGE_ID = genPageId() + " + JSON.stringify(CHATGPT_BRIDGE_MANAGED_PAGE_SUFFIX) + ";"
    );


  // Current ChatGPT can render conversation turns without data-message-author-role.
  // Reuse the released Supervisor observation contract: legacy role nodes first,
  // then bounded modern user/assistant surfaces with DOM-order correlation.
  const messageHelper = `
  function chatGptMessageRecords() {
    const legacySelector = '[data-message-author-role]';
    const modernUserSelector = 'main .text-size-chat.whitespace-pre-wrap';
    const modernAssistantSelector = "main [class*='MarkdownRoot-']";
    const records = [];
    const seen = new Set();
    const turnSelector = "main [data-testid^='conversation-turn-']";
    const turnNodes = Array.from(document.querySelectorAll(turnSelector));
    if (turnNodes.length) {
      for (const node of turnNodes) {
        const legacyRoleNode = node.querySelector(legacySelector);
        const legacyRole = String(
          legacyRoleNode?.getAttribute('data-message-author-role') || ''
        );
        const hasModernUser = Boolean(node.querySelector(modernUserSelector));
        const modernAssistant = node.querySelector(modernAssistantSelector);
        const role =
          legacyRole === 'user' || legacyRole === 'assistant'
            ? legacyRole
            : hasModernUser
              ? 'user'
              : modernAssistant
                ? 'assistant'
                : '';
        if (!role) continue;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const preferred =
          role === 'assistant'
            ? (node.querySelector('.markdown') || modernAssistant || node)
            : (legacyRoleNode || node.querySelector(modernUserSelector) || node);
        const text = String(
          preferred.innerText || preferred.textContent || ''
        ).trim();
        if (!text) continue;
        records.push({ role, node, text });
      }
      if (records.length) return records;
    }

    const push = (node, role, source) => {
      if (!node || seen.has(node)) return;
      if (role !== 'user' && role !== 'assistant') return;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      if (source !== 'legacy' && node.closest(legacySelector)) return;
      if (source === 'modern-assistant') {
        const ancestor = node.parentElement?.closest(modernAssistantSelector);
        if (ancestor && ancestor !== node) return;
      }
      const md = source === 'legacy' ? node.querySelector('.markdown') : null;
      const text = String((md ? md.innerText : (node.innerText || node.textContent)) || '').trim();
      if (!text) return;
      seen.add(node);
      records.push({ role, node, text });
    };
    for (const node of document.querySelectorAll(legacySelector)) {
      push(
        node,
        String(node.getAttribute('data-message-author-role') || ''),
        'legacy'
      );
    }
    for (const node of document.querySelectorAll(modernUserSelector)) {
      push(node, 'user', 'modern-user');
    }
    for (const node of document.querySelectorAll(modernAssistantSelector)) {
      push(node, 'assistant', 'modern-assistant');
    }
    records.sort((a, b) => {
      if (a.node === b.node) return 0;
      const relation = a.node.compareDocumentPosition(b.node);
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return records;
  }
`;

  text = text.replace(
    "  function countAssistant() {",
    messageHelper + "\n  function countAssistant() {"
  );
  text = text.replace(
    "return document.querySelectorAll('[data-message-author-role=\"assistant\"]').length;",
    "return chatGptMessageRecords().filter((item) => item.role === 'assistant').length;"
  );

  const legacyGenerating = `  function isGenerating() {
    for (const s of ['button[data-testid="stop-button"]', 'button[aria-label="停止"]', 'button[aria-label="Stop"]']) {
      const b = document.querySelector(s);
      if (b && b.offsetParent !== null) return true;
    }
    return false;
  }`;
  const hardenedGenerating = `  function isGenerating() {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        el.getClientRects().length > 0;
    };

    const main = document.querySelector('main');
    if (main) {
      if (main.getAttribute('aria-busy') === 'true') return true;
      if (Array.from(main.querySelectorAll(
        "[aria-busy='true'],[data-testid*='loading' i],[data-testid*='spinner' i],[data-testid*='progress' i]"
      )).some(visible)) return true;
    }

    for (const button of Array.from(document.querySelectorAll('main button')).slice(-80)) {
      if (!visible(button)) continue;
      const testId = String(button.getAttribute('data-testid') || '');
      const meta = [
        testId,
        button.getAttribute('aria-label'),
        button.getAttribute('title'),
        button.innerText
      ].filter(Boolean).join(' ');
      if (
        /(?:^|[-_])stop(?:[-_]|$)/i.test(testId) ||
        /(stop generating|stop response|dừng tạo|dừng phản hồi|停止)/i.test(meta)
      ) return true;
    }
    return false;
  }`;
  text = text.replace(legacyGenerating, hardenedGenerating);

  const legacySnapshotBlock = `      const turns = document.querySelectorAll('[data-message-author-role]');
      const total = turns.length;
      for (let i = Math.max(0, total - 6); i < total; i++) {
        const t = turns[i];
        const role = t.getAttribute('data-message-author-role');
        const md = t.querySelector('.markdown');
        recent.push({ role, text: (md ? md.innerText : t.innerText).trim().slice(-12000) });
      }
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      msgCount = msgs.length;
      if (msgs.length) {
        lastAssistant = (msgs[msgs.length - 1].querySelector('.markdown') || msgs[msgs.length - 1]).innerText.trim().slice(-20000);
      }`;
  const modernSnapshotBlock = `      const turns = chatGptMessageRecords();
      const total = turns.length;
      for (let i = Math.max(0, total - 6); i < total; i++) {
        const t = turns[i];
        recent.push({ role: t.role, text: t.text.slice(-12000) });
      }
      const msgs = turns.filter((item) => item.role === 'assistant');
      msgCount = msgs.length;
      if (msgs.length) {
        lastAssistant = msgs[msgs.length - 1].text.slice(-20000);
      }`;
  text = text.replace(legacySnapshotBlock, modernSnapshotBlock);

  const legacyLastReply = `    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (msgs.length) return (msgs[msgs.length - 1].querySelector('.markdown') || msgs[msgs.length - 1]).innerText.trim();
    return '';`;
  const modernLastReply = `    const msgs = chatGptMessageRecords().filter((item) => item.role === 'assistant');
    if (msgs.length) return msgs[msgs.length - 1].text;
    return '';`;
  text = text.replace(legacyLastReply, modernLastReply);

  // ChatGPT's composer submit control has changed names across UI revisions.
  // Keep upstream Bridge actuation, but widen only its ChatGPT send-control
  // selector set to the same bounded semantic/test-id contract already proven
  // by Supervisor's released composer layer. This remains Bridge-owned DOM
  // actuation; the legacy Supervisor send path is not called.
  text = text.replace(
    "['button[data-testid=\"send-button\"]', 'button[aria-label=\"发送\"]', 'button[aria-label=\"Send\"]', 'form button[type=\"submit\"]']",
    "['button[data-testid=\"send-button\"]', 'button#composer-submit-button', 'button[data-testid=\"composer-submit-button\"]', 'button[data-testid=\"composer-send-button\"]', 'button[data-testid*=\"send\" i]', 'button[data-testid*=\"submit\" i]', 'button[id*=\"send\" i]', 'button[id*=\"submit\" i]', 'button[aria-label*=\"Send\" i]', 'button[aria-label*=\"Submit\" i]', 'button[aria-label*=\"Gửi\" i]', 'button[title*=\"Send\" i]', 'button[title*=\"Submit\" i]', 'button[title*=\"Gửi\" i]', 'button[aria-label=\"发送\"]', 'form button[type=\"submit\"]']"
  );

  // Keep upstream Bridge as the actuation owner, but make its contenteditable
  // mutation observable to ChatGPT's controlled composer and mirror the
  // released bounded composer-form geometric fallback when Send metadata is
  // absent. This fallback never searches outside the active composer form.
  text = text.replace(
    `    } else {
      editor.innerHTML = '';
      document.execCommand('insertText', false, text);
    }`,
    `    } else {
      editor.focus();
      // Avoid clearing ProseMirror with innerHTML: after a reload that can
      // leave visible text in the DOM without updating ChatGPT's controlled
      // editor state, so the Send control never becomes actionable.
      const selection = globalThis.getSelection?.();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      document.execCommand('insertText', false, text);
      editor.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text
      }));
    }`
  );

  text = text.replace(
    `      for (const sel of sendBtns) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) { btn.click(); break; }
      }
      await sleep(1500);`,
    `      let controlClicked = false;
      for (const sel of sendBtns) {
        const btn = document.querySelector(sel);
        if (
          btn &&
          btn.offsetParent !== null &&
          !btn.disabled &&
          btn.getAttribute('aria-disabled') !== 'true'
        ) {
          btn.click();
          controlClicked = true;
          break;
        }
      }

      if (!controlClicked && SITE === 'chatgpt') {
        const form = editor.closest('form');
        const formBox = form ? form.getBoundingClientRect() : null;
        const rejectRe = /(attach|attachment|file|upload|plus|add|voice|mic|microphone|dictat|audio|model|tool|stop|retry|continue|tệp|đính kèm|thêm|giọng|âm thanh)/i;
        let best = null;
        if (form && formBox && formBox.width > 0 && formBox.height > 0) {
          for (const btn of Array.from(form.querySelectorAll('button')).slice(0, 40)) {
            const style = getComputedStyle(btn);
            const box = btn.getBoundingClientRect();
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              btn.disabled ||
              btn.getAttribute('aria-disabled') === 'true' ||
              box.width < 22 ||
              box.height < 22 ||
              box.width > 96 ||
              box.height > 96
            ) continue;

            const attrs = [
              btn.getAttribute('aria-label'),
              btn.getAttribute('title'),
              btn.getAttribute('data-testid'),
              btn.id,
              btn.getAttribute('type'),
              btn.innerText
            ].filter(Boolean).join(' ');
            if (rejectRe.test(attrs)) continue;

            const centerX = box.left + box.width / 2;
            const centerY = box.top + box.height / 2;
            const rightBand = formBox.left + formBox.width * 0.62;
            const lowerBand = formBox.top + formBox.height * 0.35;
            if (centerX < rightBand || centerY < lowerBand) continue;

            let score = centerX - formBox.left;
            if (String(btn.getAttribute('type') || '').toLowerCase() === 'submit') score += 1000;
            if (/(send|submit|gửi)/i.test(attrs)) score += 2000;
            if (!best || score > best.score) best = { btn, score };
          }
        }
        if (best) {
          best.btn.click();
          controlClicked = true;
        }

        // If ChatGPT has hydrated the composer but has not materialized an
        // actionable Send button yet, invoke the native form submission path.
        // This remains scoped to the exact composer form and only runs after
        // Enter + semantic/geometric Send controls did not actuate.
        if (
          !controlClicked &&
          form &&
          typeof form.requestSubmit === 'function' &&
          String(editor.innerText || editor.value || '').trim().length > 0
        ) {
          form.requestSubmit();
          controlClicked = true;
        }
      }
      await sleep(1500);`
  );

  // Upstream /poll dequeues commands even while the page-side executor is
  // busy. Preserve such commands locally so a command observed during the
  // short post-response busy window cannot be silently lost.
  text = text.replace(
    `  let busy = false;
  let busySince = 0;`,
    `  let busy = false;
  let busySince = 0;
  const pendingCommands = [];`
  );

  text = text.replace(
    `        if (resp && resp.cmd && !busy) {
          busy = true;
          busySince = Date.now();
          setStatus('执行: ' + (resp.cmd === 'send' ? '发送' : resp.cmd), '#c83');
          // 关键:命令处理放独立异步函数,不阻塞 poll 循环
          executeCommand(resp);
        }`,
    `        if (resp && resp.cmd) {
          pendingCommands.push(resp);
        }
        if (!busy && pendingCommands.length) {
          const nextCommand = pendingCommands.shift();
          busy = true;
          busySince = Date.now();
          setStatus('执行: ' + (nextCommand.cmd === 'send' ? '发送' : nextCommand.cmd), '#c83');
          // Preserve commands dequeued by /poll while a previous command is
          // still finishing. Execute serially instead of silently dropping.
          executeCommand(nextCommand);
        }`
  );

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

export async function waitForChatSurfaceReady(
  browserAdapter,
  page,
  role,
  {
    timeoutMs = 60_000,
    pollIntervalMs = 300
  } = {}
) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 60_000);
  let last = null;
  while (Date.now() <= deadline) {
    last = await browserAdapter.probePage(page).catch(() => null);
    const snap = last?.snapshot;
    if (snap?.loginRequired || snap?.hasCaptcha) {
      throw new Error(role + " ChatGPT surface requires owner intervention");
    }
    if (
      snap?.conversationPath &&
      snap?.composerReady &&
      !snap?.hasNetworkError &&
      !snap?.hasTransientError &&
      !snap?.conversationMissing
    ) return last;
    await sleep(Math.max(1, Number(pollIntervalMs) || 300));
  }
  throw new Error(role + " ChatGPT surface did not become ready after reload");
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
  // left by a previous Bridge CLI process. Refresh role pages sequentially:
  // concurrent ChatGPT conversation reloads can leave the background role
  // without a hydrated composer even though both targets were healthy before
  // reload. Conversation identity is preserved and each role must become ready
  // before the next role is refreshed.
  await warm.plannerPage.reload({ waitUntil: "domcontentloaded" });
  await waitForChatSurfaceReady(browserAdapter, warm.plannerPage, "Planner");
  await warm.executorPage.reload({ waitUntil: "domcontentloaded" });
  await waitForChatSurfaceReady(browserAdapter, warm.executorPage, "Executor");

  const injections = await Promise.all([
    injectPinnedBridgeUserscript(warm.plannerPage, userscriptSource, { bindingName }),
    injectPinnedBridgeUserscript(warm.executorPage, userscriptSource, { bindingName })
  ]);

  let binding = await waitForBinding(bridgeAdapter, {
    plannerUrl,
    executorUrl,
    requireExactPageSet
  });

  async function refresh() {
    try {
      assertPlannerExecutorWarmTabs(browserAdapter, warm);
      binding = await bindPlannerExecutorBridgePages(bridgeAdapter, {
        plannerUrl,
        executorUrl,
        requireExactPageSet
      });
      return { warm, binding, recovered: false, reinjected: false };
    } catch {
      const recovered = await recover();
      return { ...recovered, recovered: true };
    }
  }

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
    refresh,
    recover
  };
}
