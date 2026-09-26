import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLaneDirective } from "../../src/runtime/three-lane.mjs";

const stateRoot = process.argv[2];
if (!stateRoot) throw new Error("state root arg is required");

const registry = JSON.parse(
  String(await fs.readFile(path.join(stateRoot, "lane-registry.json"), "utf8"))
    .replace(/^\uFEFF/, "")
);
const brainUrl = String(registry?.lanes?.["lane-1"]?.brain_url || "");
if (!brainUrl) {
  console.log("BRAIN_DOM_URL_PRESENT=False");
  process.exit(0);
}
console.log("BRAIN_DOM_URL_PRESENT=True");

function conversationId(value) {
  try {
    const u = new URL(value);
    const m = u.pathname.match(/\/c\/(?:WEB:)?([0-9a-fA-F-]{36})\/?$/);
    return m ? m[1].toLowerCase() : "";
  } catch {
    return "";
  }
}
const expectedId = conversationId(brainUrl);
const pages = await fetch("http://127.0.0.1:9222/json/list").then((r) => r.json());
const candidates = pages.filter((item) =>
  item?.type === "page" &&
  String(item.url || "").startsWith("https://chatgpt.com/")
);
const target = candidates.find((item) =>
  expectedId && conversationId(item.url) === expectedId
) || candidates.find((item) => String(item.url || "") === brainUrl);

console.log(`BRAIN_DOM_PAGE_COUNT=${candidates.length}`);
console.log(`BRAIN_DOM_TARGET_FOUND=${Boolean(target)}`);
if (!target?.webSocketDebuggerUrl) process.exit(0);

function cdpEvaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("CDP evaluate timeout"));
    }, 7000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression,
          returnByValue: true,
          awaitPromise: true
        }
      }));
    });
    ws.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.error) return reject(new Error(msg.error.message));
      resolve(msg?.result?.result?.value ?? null);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP websocket error"));
    });
  });
}

const expression = `(() => {
  const roleNodes = Array.from(document.querySelectorAll("[data-message-author-role]"))
    .slice(-12)
    .map((node) => ({
      role: String(node.getAttribute("data-message-author-role") || "").trim(),
      text: String(node.innerText || node.textContent || "").trim()
    }));
  const turnNodes = Array.from(document.querySelectorAll("[data-testid^='conversation-turn-']"))
    .slice(-12)
    .map((node) => ({
      testid: String(node.getAttribute("data-testid") || ""),
      roles: Array.from(node.querySelectorAll("[data-message-author-role]"))
        .map((n) => String(n.getAttribute("data-message-author-role") || "").trim())
        .filter(Boolean),
      text: String(node.innerText || node.textContent || "").trim()
    }));
  const marker = "<<<MAGASIN_LANE_DIRECTIVE_V1>>>";
  const markerNodes = Array.from(document.querySelectorAll("main *"))
    .filter((el) => {
      const text = String(el.innerText || el.textContent || "");
      if (!text.includes(marker)) return false;
      return !Array.from(el.children || []).some((child) =>
        String(child.innerText || child.textContent || "").includes(marker)
      );
    })
    .slice(-12)
    .map((el) => {
      const lineage = [];
      let node = el;
      for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
        lineage.push({
          tag: String(node.tagName || ""),
          id: String(node.id || ""),
          cls: String(node.className || "").slice(0, 180),
          testid: String(node.getAttribute?.("data-testid") || ""),
          role: String(node.getAttribute?.("role") || ""),
          author: String(node.getAttribute?.("data-message-author-role") || ""),
          messageId: String(node.getAttribute?.("data-message-id") || ""),
          dataRole: String(node.getAttribute?.("data-role") || "")
        });
      }
      const text = String(el.innerText || el.textContent || "").trim();
      return {
        text,
        hasBrainRequestId: text.includes("brain_request_id="),
        lineage
      };
    });
  const composer = document.querySelector("#prompt-textarea,[contenteditable][role='textbox'],textarea,[contenteditable]");
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return style.display !== "none" &&
      style.visibility !== "hidden" &&
      box.width > 0 &&
      box.height > 0;
  };
  const describe = (el) => {
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return {
      tag: String(el.tagName || ""),
      id: String(el.id || ""),
      role: String(el.getAttribute?.("role") || ""),
      type: String(el.getAttribute?.("type") || ""),
      testid: String(el.getAttribute?.("data-testid") || ""),
      aria: String(el.getAttribute?.("aria-label") || ""),
      title: String(el.getAttribute?.("title") || ""),
      contenteditable: String(el.getAttribute?.("contenteditable") || ""),
      disabled: Boolean(el.disabled) || el.getAttribute?.("aria-disabled") === "true",
      visible: visible(el),
      cls: String(el.className || "").replace(/[\r\n|]+/g, " ").slice(0, 220),
      text: String(el.innerText || el.textContent || "").trim().slice(0, 120),
      x: Math.round(box.x),
      y: Math.round(box.y),
      w: Math.round(box.width),
      h: Math.round(box.height)
    };
  };
  const composerForm = composer?.closest("form") || null;
  const controls = Array.from((composerForm || document).querySelectorAll("button,[role='button']"))
    .filter(visible)
    .slice(-30)
    .map(describe);
  const composerText = composer
    ? String(
        composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
          ? composer.value
          : composer.innerText || composer.textContent || ""
      ).trim()
    : "";
  return {
    url: location.href,
    visibility: document.visibilityState,
    roleNodes,
    turnNodes,
    markerNodes,
    composerPresent: Boolean(composer),
    composer: describe(composer),
    composerTextLength: composerText.length,
    composerForm: describe(composerForm),
    controls
  };
})()`;

const dom = await cdpEvaluate(target.webSocketDebuggerUrl, expression);
console.log(`BRAIN_DOM_VISIBILITY=${String(dom?.visibility || "")}`);
console.log(`BRAIN_DOM_COMPOSER_PRESENT=${Boolean(dom?.composerPresent)}`);
console.log(`BRAIN_DOM_COMPOSER_TEXT_LENGTH=${Number(dom?.composerTextLength || 0)}`);
if (dom?.composer) {
  const x = dom.composer;
  console.log(`BRAIN_DOM_COMPOSER=TAG=${x.tag}|ID=${x.id}|ROLE=${x.role}|TESTID=${x.testid}|CONTENTEDITABLE=${x.contenteditable}|DISABLED=${x.disabled}|VISIBLE=${x.visible}|RECT=${x.x},${x.y},${x.w},${x.h}|CLASS=${x.cls}`);
}
if (dom?.composerForm) {
  const x = dom.composerForm;
  console.log(`BRAIN_DOM_FORM=TAG=${x.tag}|ID=${x.id}|ROLE=${x.role}|TESTID=${x.testid}|CLASS=${x.cls}`);
}
const controls = Array.isArray(dom?.controls) ? dom.controls : [];
console.log(`BRAIN_DOM_CONTROL_COUNT=${controls.length}`);
for (let i = 0; i < controls.length; i += 1) {
  const x = controls[i] || {};
  console.log(`BRAIN_DOM_CONTROL[${i}]=TAG=${x.tag}|TYPE=${x.type}|TESTID=${x.testid}|ARIA=${String(x.aria || "").replace(/[\r\n|]+/g," ").slice(0,120)}|TITLE=${String(x.title || "").replace(/[\r\n|]+/g," ").slice(0,120)}|DISABLED=${x.disabled}|VISIBLE=${x.visible}|RECT=${x.x},${x.y},${x.w},${x.h}|TEXT=${String(x.text || "").replace(/[\r\n|]+/g," ").slice(0,80)}|CLASS=${String(x.cls || "").replace(/[\r\n|]+/g," ").slice(0,180)}`);
}
console.log(`BRAIN_DOM_ROLE_NODE_COUNT=${Array.isArray(dom?.roleNodes) ? dom.roleNodes.length : 0}`);
console.log(`BRAIN_DOM_TURN_NODE_COUNT=${Array.isArray(dom?.turnNodes) ? dom.turnNodes.length : 0}`);

const digest = (value) => crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
const roleNodes = Array.isArray(dom?.roleNodes) ? dom.roleNodes : [];
for (let i = Math.max(0, roleNodes.length - 6); i < roleNodes.length; i += 1) {
  const item = roleNodes[i] || {};
  const text = String(item.text || "");
  console.log(`BRAIN_DOM_ROLE[${i}]=${String(item.role || "")}|CHARS=${text.length}|DIGEST=${digest(text)}`);
  if (String(item.role || "") === "assistant") {
    try {
      const directive = parseLaneDirective(text);
      console.log(
        `BRAIN_DOM_PARSE[${i}]=PASS|ACTION=${directive.action}|PLAN=${Boolean(directive.project_plan)}|TASKS=${directive.project_plan?.tasks?.length || 0}|DONE=${directive.project_plan?.completed_task_ids?.length || 0}|DIGEST=${directive.digest}`
      );
    } catch (error) {
      console.log(`BRAIN_DOM_PARSE[${i}]=FAIL|ERROR=${String(error?.message || error).replace(/[\r\n]+/g, " ").slice(0, 260)}`);
    }
  }
}

const turnNodes = Array.isArray(dom?.turnNodes) ? dom.turnNodes : [];
for (let i = Math.max(0, turnNodes.length - 4); i < turnNodes.length; i += 1) {
  const item = turnNodes[i] || {};
  const text = String(item.text || "");
  console.log(
    `BRAIN_DOM_TURN[${i}]=${String(item.testid || "")}|ROLES=${(item.roles || []).join(",")}|CHARS=${text.length}|DIGEST=${digest(text)}`
  );
}

const markerNodes = Array.isArray(dom?.markerNodes) ? dom.markerNodes : [];
console.log(`BRAIN_DOM_MARKER_NODE_COUNT=${markerNodes.length}`);
for (let i = Math.max(0, markerNodes.length - 6); i < markerNodes.length; i += 1) {
  const item = markerNodes[i] || {};
  const text = String(item.text || "");
  console.log(`BRAIN_DOM_MARKER[${i}]=CHARS=${text.length}|DIGEST=${digest(text)}|REQUEST_ID=${Boolean(item.hasBrainRequestId)}`);
  for (let depth = 0; depth < Math.min(4, (item.lineage || []).length); depth += 1) {
    const n = item.lineage[depth] || {};
    console.log(`BRAIN_DOM_LINEAGE[${i}][${depth}]=TAG=${n.tag}|ID=${n.id}|TESTID=${n.testid}|ROLE=${n.role}|AUTHOR=${n.author}|DATA_ROLE=${n.dataRole}|MESSAGE_ID=${n.messageId}|CLASS=${String(n.cls || "").replace(/[\r\n|]+/g," ").slice(0,180)}`);
  }
  try {
    const directive = parseLaneDirective(text);
    console.log(`BRAIN_DOM_MARKER_PARSE[${i}]=PASS|ACTION=${directive.action}|PLAN=${Boolean(directive.project_plan)}|TASKS=${directive.project_plan?.tasks?.length || 0}|DONE=${directive.project_plan?.completed_task_ids?.length || 0}|DIGEST=${directive.digest}`);
  } catch (error) {
    console.log(`BRAIN_DOM_MARKER_PARSE[${i}]=FAIL|ERROR=${String(error?.message || error).replace(/[\r\n]+/g," ").slice(0,260)}`);
  }
}
