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
  const composer = document.querySelector("#prompt-textarea,[contenteditable='true'][role='textbox'],textarea");
  return {
    url: location.href,
    visibility: document.visibilityState,
    roleNodes,
    turnNodes,
    composerPresent: Boolean(composer)
  };
})()`;

const dom = await cdpEvaluate(target.webSocketDebuggerUrl, expression);
console.log(`BRAIN_DOM_VISIBILITY=${String(dom?.visibility || "")}`);
console.log(`BRAIN_DOM_COMPOSER_PRESENT=${Boolean(dom?.composerPresent)}`);
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
