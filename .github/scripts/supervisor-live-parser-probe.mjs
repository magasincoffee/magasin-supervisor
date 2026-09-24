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
const three = await import(
  pathToFileURL(path.join(runtime, "src", "runtime", "three-lane.mjs")).href
);
const capture = await import(
  pathToFileURL(path.join(runtime, "src", "ui", "message-capture.mjs")).href
);
const pw = await import(
  pathToFileURL(path.join(runtime, "node_modules", "playwright-core", "index.js")).href
);

const browser = await pw.chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0] || null;
const pages = context
  ? context.pages().filter((page) => {
      try {
        const url = new URL(page.url());
        return url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com");
      } catch {
        return false;
      }
    })
  : [];

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

process.exit(0);
