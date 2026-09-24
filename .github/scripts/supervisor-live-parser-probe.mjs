import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtime = process.env.PROBE_RUNTIME_DIR;
const configFile = process.env.PROBE_CONFIG_FILE;
const cdpUrl = process.env.PROBE_CDP_URL;

if (!runtime || !configFile || !cdpUrl) {
  throw new Error("live parser probe environment is incomplete");
}

const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
const lane = config.lanes.find((item) => item.lane_id === "lane-1") || {};
const sourceRoot = process.env.GITHUB_WORKSPACE || runtime;
const three = await import(
  pathToFileURL(path.join(sourceRoot, "src", "runtime", "three-lane.mjs")).href
);
const capture = await import(
  pathToFileURL(path.join(sourceRoot, "src", "ui", "message-capture.mjs")).href
);
const sourceSnapshot = await import(
  pathToFileURL(path.join(sourceRoot, "src", "ui", "snapshot.mjs")).href
);
const adapterMod = await import(
  pathToFileURL(path.join(runtime, "src", "ui", "playwright-adapter.mjs")).href
);
const adapter = new adapterMod.ChatGptUiAdapter({ cdpUrl, settleMs: 250 });
await adapter.open();
const pages = adapter.getChatGptPages();

console.log("LIVE_PROBE_CHATGPT_PAGES=" + pages.length);

const expectedHandshake = three.sha256(
  three.buildBrainStartRequest({
    laneId: "lane-1",
    projectName: String(lane.project_name || "Dự án 1")
  })
);

let pageIndex = 0;
for (const page of pages) {
  pageIndex += 1;
  let redacted = "[UNKNOWN]";
  try {
    const url = new URL(page.url());
    const kind = /^\/(c|g|project)\//.exec(url.pathname)?.[1] || "other";
    redacted = "https://chatgpt.com/" + kind + "/[REDACTED]";
  } catch {}
  console.log("LIVE_PAGE_" + pageIndex + "_URL=" + redacted);

  const uiProbe = await adapter.probePage(page).catch(() => null);
  if (uiProbe?.snapshot) {
    console.log("LIVE_PAGE_" + pageIndex + "_SNAPSHOT_PATH_KIND=" + String(uiProbe.snapshot.pathKind || ""));
    console.log("LIVE_PAGE_" + pageIndex + "_SNAPSHOT_COMPOSER_READY=" + Boolean(uiProbe.snapshot.composerReady));
    console.log("LIVE_PAGE_" + pageIndex + "_SNAPSHOT_MAIN_TEXT_CHARS=" + Number(uiProbe.snapshot.mainTextCharCount || 0));
    console.log("LIVE_PAGE_" + pageIndex + "_SNAPSHOT_MAIN_ELEMENTS=" + Number(uiProbe.snapshot.mainElementCount || 0));
    console.log("LIVE_PAGE_" + pageIndex + "_SNAPSHOT_ASSISTANT_COUNT=" + Number(uiProbe.snapshot.assistantMessageCount || 0));
    console.log("LIVE_PAGE_" + pageIndex + "_SNAPSHOT_USER_COUNT=" + Number(uiProbe.snapshot.userMessageCount || 0));
    console.log("LIVE_PAGE_" + pageIndex + "_SNAPSHOT_MAX_TURN=" + Number(uiProbe.snapshot.maxConversationTurnOrdinal || 0));
    console.log("LIVE_PAGE_" + pageIndex + "_SNAPSHOT_LAST_ROLE=" + String(uiProbe.snapshot.lastMessageRole || ""));
  }

  const domMeta = await page.evaluate(() => {
    const safeAttrs = (node) => ({
      tag: String(node?.tagName || "").toLowerCase(),
      testid: String(node?.getAttribute?.("data-testid") || ""),
      role: String(node?.getAttribute?.("role") || ""),
      aria: String(node?.getAttribute?.("aria-label") || "").slice(0, 80),
      dataAuthor: String(node?.getAttribute?.("data-message-author-role") || ""),
      className: typeof node?.className === "string" ? node.className.slice(0, 160) : "",
      textLen: Number(String(node?.innerText || node?.textContent || "").trim().length),
      childCount: Number(node?.children?.length || 0)
    });
    const turns = Array.from(document.querySelectorAll("[data-testid^='conversation-turn-']")).slice(-12);
    const articles = Array.from(document.querySelectorAll("main article")).slice(-12);
    const testids = Array.from(document.querySelectorAll("main [data-testid]"))
      .filter((node) => /conversation|turn|message|assistant|user|response/i.test(String(node.getAttribute("data-testid") || "")))
      .slice(-40);
    return {
      readyState: document.readyState,
      main: document.querySelector("main") ? safeAttrs(document.querySelector("main")) : null,
      turnCount: turns.length,
      turns: turns.map(safeAttrs),
      articleCount: articles.length,
      articles: articles.map(safeAttrs),
      interestingTestIdCount: testids.length,
      interestingTestIds: testids.map(safeAttrs),
      authorRoleCount: document.querySelectorAll("[data-message-author-role]").length
    };
  }).catch(() => null);

  if (domMeta) {
    console.log("LIVE_PAGE_" + pageIndex + "_DOM_READY=" + String(domMeta.readyState || ""));
    console.log("LIVE_PAGE_" + pageIndex + "_DOM_AUTHOR_ROLE_COUNT=" + Number(domMeta.authorRoleCount || 0));
    console.log("LIVE_PAGE_" + pageIndex + "_DOM_TURN_COUNT=" + Number(domMeta.turnCount || 0));
    console.log("LIVE_PAGE_" + pageIndex + "_DOM_ARTICLE_COUNT=" + Number(domMeta.articleCount || 0));
    console.log("LIVE_PAGE_" + pageIndex + "_DOM_INTERESTING_TESTID_COUNT=" + Number(domMeta.interestingTestIdCount || 0));
    console.log("LIVE_PAGE_" + pageIndex + "_DOM_MAIN=" + JSON.stringify(domMeta.main || {}));
    let metaIndex = 0;
    for (const meta of domMeta.turns || []) {
      metaIndex += 1;
      console.log("LIVE_PAGE_" + pageIndex + "_DOM_TURN_" + metaIndex + "=" + JSON.stringify(meta));
    }
    metaIndex = 0;
    for (const meta of domMeta.articles || []) {
      metaIndex += 1;
      console.log("LIVE_PAGE_" + pageIndex + "_DOM_ARTICLE_" + metaIndex + "=" + JSON.stringify(meta));
    }
    metaIndex = 0;
    for (const meta of domMeta.interestingTestIds || []) {
      metaIndex += 1;
      console.log("LIVE_PAGE_" + pageIndex + "_DOM_TESTID_" + metaIndex + "=" + JSON.stringify(meta));
    }
  }

  const structuralMeta = await page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return null;
    const out = [];
    const datasetNodes = [];
    const queue = [{ node: main, depth: 0 }];
    while (queue.length && out.length < 140) {
      const { node, depth } = queue.shift();
      if (!(node instanceof Element)) continue;
      const textLen = String(node.innerText || node.textContent || "").trim().length;
      const attrs = Array.from(node.attributes || [])
        .map((attr) => String(attr.name || ""))
        .filter((name) => name.startsWith("data-") || name === "role" || name === "aria-label")
        .slice(0, 20);
      const datasetKeys = Object.keys(node.dataset || {}).slice(0, 20);
      if (depth > 0 && (textLen >= 40 || attrs.length || datasetKeys.length)) {
        out.push({
          depth,
          tag: String(node.tagName || "").toLowerCase(),
          className: typeof node.className === "string" ? node.className.slice(0, 180) : "",
          role: String(node.getAttribute("role") || ""),
          ariaLen: String(node.getAttribute("aria-label") || "").length,
          textLen,
          childCount: node.children.length,
          attrs,
          datasetKeys
        });
      }
      if (datasetKeys.length && datasetNodes.length < 80) {
        datasetNodes.push({
          depth,
          tag: String(node.tagName || "").toLowerCase(),
          className: typeof node.className === "string" ? node.className.slice(0, 180) : "",
          textLen,
          childCount: node.children.length,
          datasetKeys
        });
      }
      if (depth < 7) {
        for (const child of node.children) queue.push({ node: child, depth: depth + 1 });
      }
    }
    return { nodes: out, datasetNodes };
  }).catch(() => null);
  if (structuralMeta) {
    let structuralIndex = 0;
    for (const meta of structuralMeta.nodes || []) {
      structuralIndex += 1;
      console.log("LIVE_PAGE_" + pageIndex + "_STRUCT_" + structuralIndex + "=" + JSON.stringify(meta));
    }
    let datasetIndex = 0;
    for (const meta of structuralMeta.datasetNodes || []) {
      datasetIndex += 1;
      console.log("LIVE_PAGE_" + pageIndex + "_DATASET_" + datasetIndex + "=" + JSON.stringify(meta));
    }
  }

  const deepMeta = await page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return null;
    const all = Array.from(main.querySelectorAll("*"));
    const interesting = all
      .filter((node) => {
        const cls = typeof node.className === "string" ? node.className : "";
        const attrs = Array.from(node.attributes || []).map((a) => a.name).join(" ");
        return /turn|message|thread|response|assistant|user|conversation|markdown|prose/i.test(cls + " " + attrs);
      })
      .slice(-120)
      .map((node) => ({
        tag: String(node.tagName || "").toLowerCase(),
        className: typeof node.className === "string" ? node.className.slice(0, 220) : "",
        role: String(node.getAttribute("role") || ""),
        textLen: String(node.innerText || node.textContent || "").trim().length,
        childCount: node.children.length,
        attrNames: Array.from(node.attributes || []).map((a) => a.name).filter((n) => n.startsWith("data-") || n === "role").slice(0, 20)
      }));

    const groups = new Map();
    for (const node of all) {
      const textLen = String(node.innerText || node.textContent || "").trim().length;
      if (textLen < 80) continue;
      const cls = typeof node.className === "string" ? node.className.trim() : "";
      if (!cls) continue;
      const key = String(node.tagName || "").toLowerCase() + "|" + cls.slice(0, 220);
      if (!groups.has(key)) groups.set(key, { count: 0, min: Number.POSITIVE_INFINITY, max: 0, childCounts: [] });
      const g = groups.get(key);
      g.count += 1;
      g.min = Math.min(g.min, textLen);
      g.max = Math.max(g.max, textLen);
      if (g.childCounts.length < 8) g.childCounts.push(node.children.length);
    }
    const repeated = Array.from(groups.entries())
      .filter(([, g]) => g.count >= 2)
      .sort((a, b) => b[1].count - a[1].count || b[1].max - a[1].max)
      .slice(0, 80)
      .map(([key, g]) => ({ key, ...g }));

    const leafish = all
      .filter((node) => {
        const len = String(node.innerText || node.textContent || "").trim().length;
        return len >= 80 && len <= 12000 && node.children.length <= 8;
      })
      .slice(-120)
      .map((node) => ({
        tag: String(node.tagName || "").toLowerCase(),
        className: typeof node.className === "string" ? node.className.slice(0, 220) : "",
        role: String(node.getAttribute("role") || ""),
        textLen: String(node.innerText || node.textContent || "").trim().length,
        childCount: node.children.length,
        attrNames: Array.from(node.attributes || []).map((a) => a.name).filter((n) => n.startsWith("data-") || n === "role").slice(0, 20)
      }));

    return { interesting, repeated, leafish };
  }).catch(() => null);
  if (deepMeta) {
    let deepIndex = 0;
    for (const meta of deepMeta.interesting || []) {
      deepIndex += 1;
      console.log("LIVE_PAGE_" + pageIndex + "_DEEP_INTEREST_" + deepIndex + "=" + JSON.stringify(meta));
    }
    deepIndex = 0;
    for (const meta of deepMeta.repeated || []) {
      deepIndex += 1;
      console.log("LIVE_PAGE_" + pageIndex + "_DEEP_GROUP_" + deepIndex + "=" + JSON.stringify(meta));
    }
    deepIndex = 0;
    for (const meta of deepMeta.leafish || []) {
      deepIndex += 1;
      console.log("LIVE_PAGE_" + pageIndex + "_DEEP_LEAF_" + deepIndex + "=" + JSON.stringify(meta));
    }
  }

  const fixedSnapshot = await sourceSnapshot.collectSafeUiSnapshot(page).catch(() => null);
  if (fixedSnapshot) {
    console.log("LIVE_PAGE_" + pageIndex + "_SOURCE_SNAPSHOT_ASSISTANT_COUNT=" + Number(fixedSnapshot.assistantMessageCount || 0));
    console.log("LIVE_PAGE_" + pageIndex + "_SOURCE_SNAPSHOT_USER_COUNT=" + Number(fixedSnapshot.userMessageCount || 0));
    console.log("LIVE_PAGE_" + pageIndex + "_SOURCE_SNAPSHOT_MAX_TURN=" + Number(fixedSnapshot.maxConversationTurnOrdinal || 0));
    console.log("LIVE_PAGE_" + pageIndex + "_SOURCE_SNAPSHOT_LAST_ROLE=" + String(fixedSnapshot.lastMessageRole || ""));
    console.log("LIVE_PAGE_" + pageIndex + "_SOURCE_SNAPSHOT_RESPONSE_RUNNING=" + Boolean(fixedSnapshot.responseRunning));
  }

  const userDigests = await capture.captureUserTurnDigests(page).catch(() => []);
  console.log("LIVE_PAGE_" + pageIndex + "_USER_TURN_COUNT=" + userDigests.length);
  console.log(
    "LIVE_PAGE_" + pageIndex + "_EXPECTED_HANDSHAKE_PRESENT=" +
      userDigests.includes(expectedHandshake)
  );

  const turns = await capture
    .captureRecentConversationTurns(page, { limit: 24 })
    .catch(() => []);
  console.log("LIVE_PAGE_" + pageIndex + "_TURN_COUNT=" + turns.length);

  const tail = turns.slice(-10);
  let tailIndex = 0;
  for (const turn of tail) {
    tailIndex += 1;
    const text = String(turn.text || "");
    console.log(
      "LIVE_PAGE_" + pageIndex + "_TAIL_" + tailIndex + "_ROLE=" +
        String(turn.role || "")
    );
    console.log(
      "LIVE_PAGE_" + pageIndex + "_TAIL_" + tailIndex + "_LEN=" + text.length
    );
    console.log(
      "LIVE_PAGE_" + pageIndex + "_TAIL_" + tailIndex + "_HAS_START=" +
        text.includes("<<<MAGASIN_LANE_DIRECTIVE_V1>>>")
    );
    console.log(
      "LIVE_PAGE_" + pageIndex + "_TAIL_" + tailIndex + "_HAS_END=" +
        text.includes("<<<END_MAGASIN_LANE_DIRECTIVE_V1>>>")
    );
  }

  let valid = null;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role !== "assistant") continue;
    try {
      valid = three.parseLaneDirective(turns[index].text);
      break;
    } catch {}
  }

  console.log(
    "LIVE_PAGE_" + pageIndex + "_LATEST_VALID_DIRECTIVE=" + Boolean(valid)
  );
  if (valid) {
    console.log(
      "LIVE_PAGE_" + pageIndex + "_DIRECTIVE_ACTION=" + valid.action
    );
    console.log(
      "LIVE_PAGE_" + pageIndex + "_DIRECTIVE_TASK_ID=" +
        String(valid.task_id || "")
    );
    console.log(
      "LIVE_PAGE_" + pageIndex + "_DIRECTIVE_DIGEST=" +
        String(valid.digest || "")
    );
  }

  const completed = await capture
    .captureCompletedAssistantTurn(page)
    .catch(() => null);
  console.log(
    "LIVE_PAGE_" + pageIndex + "_COMPLETED_ASSISTANT_PRESENT=" +
      Boolean(completed)
  );
  if (completed) {
    console.log(
      "LIVE_PAGE_" + pageIndex + "_COMPLETED_ASSISTANT_LEN=" +
        String(completed.text || "").length
    );
    try {
      const parsed = three.parseLaneDirective(completed.text);
      console.log("LIVE_PAGE_" + pageIndex + "_COMPLETED_PARSE_OK=True");
      console.log(
        "LIVE_PAGE_" + pageIndex + "_COMPLETED_ACTION=" + parsed.action
      );
      console.log(
        "LIVE_PAGE_" + pageIndex + "_COMPLETED_TASK_ID=" +
          String(parsed.task_id || "")
      );
    } catch (error) {
      console.log("LIVE_PAGE_" + pageIndex + "_COMPLETED_PARSE_OK=False");
      console.log(
        "LIVE_PAGE_" + pageIndex + "_COMPLETED_PARSE_ERROR=" +
          String(error?.message || error).slice(0, 180)
      );
    }
  }
}

await adapter.close().catch(() => {});
process.exit(0);
