import fs from "node:fs/promises";
import process from "node:process";
import { chromium } from "playwright-core";

const cdpUrl = String(process.argv[2] || "").trim();
const idsPath = String(process.argv[3] || "").trim();
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl)) throw new Error("local CDP URL is required");
const ids = JSON.parse(await fs.readFile(idsPath, "utf8"));
if (!Array.isArray(ids) || ids.length < 5) throw new Error("five cycle ids are required");

const browser = await chromium.connectOverCDP(cdpUrl);
let exitCode = 0;
try {
  const pages = browser.contexts().flatMap((context) => context.pages()).filter((page) => {
    try {
      const host = new URL(page.url()).hostname;
      return host === "chatgpt.com" || host.endsWith(".chatgpt.com");
    } catch {
      return false;
    }
  });
  console.log("SC010_LIVE_CHATGPT_PAGE_COUNT=" + pages.length);
  if (pages.length !== 1) throw new Error("steady state does not have exactly one ChatGPT page");

  const page = pages[0];
  const proof = await page.evaluate((wantedIds) => {
    const clean = (value) => String(value || "").replace(/[\u200B-\u200F\u2060\uFEFF]/g, "").replace(/\s+/g, " ").trim();
    const legacy = Array.from(document.querySelectorAll('main [data-message-author-role="user"]'));
    const modern = Array.from(document.querySelectorAll("main .text-size-chat.whitespace-pre-wrap"))
      .filter((node) => !node.closest?.("#prompt-textarea,[contenteditable='true'],textarea"));
    const nodes = legacy.length ? legacy : modern;
    const uniqueNodes = [...new Set(nodes)];
    const texts = uniqueNodes.map((node) => clean(node.innerText || node.textContent || "")).filter(Boolean);
    const counts = {};
    for (const id of wantedIds) {
      const marker = "MAGASIN_CYCLE_CORRELATION_V1 " + id;
      counts[id] = texts.filter((text) => text.includes(marker)).length;
    }
    return {
      path: location.pathname,
      counts,
      user_count: texts.length
    };
  }, ids);

  console.log("SC010_LIVE_CHAT_PATH=" + proof.path);
  console.log("SC010_LIVE_USER_TURN_COUNT=" + proof.user_count);
  for (const id of ids) {
    const count = Number(proof.counts?.[id] || 0);
    console.log("SC010_LIVE_USER_CORRELATION_" + id + "_COUNT=" + count);
    if (count !== 1) throw new Error("cycle correlation was not delivered exactly once: " + id);
  }
  console.log("SC010_LIVE_EXACT_ONCE_DOM=True");
} catch (error) {
  console.error("SC010_LIVE_DOM_ERROR=" + String(error?.message || error));
  exitCode = 1;
} finally {
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1500))
  ]);
}
process.exit(exitCode);
