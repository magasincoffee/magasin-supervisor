import fs from "node:fs/promises";
import process from "node:process";
import { chromium } from "playwright-core";

const cdpUrl = String(process.argv[2] || "").trim();
const statePath = String(process.argv[3] || "").trim();
const startedAt = new Date(String(process.argv[4] || ""));
const timeoutMs = Number(process.argv[5] || 1_320_000);

if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl)) throw new Error("local CDP URL is required");
if (!statePath) throw new Error("state path is required");
if (!Number.isFinite(startedAt.getTime())) throw new Error("qualification start time is required");

const clean = (value) => String(value || "").replace(/[\u200B-\u200F\u2060\uFEFF]/g, "").replace(/\s+/g, " ").trim();
const deadline = Date.now() + timeoutMs;
let browser = null;
let maxNextWorkAge = 0;
let candidateStateObserved = false;

async function bounded(label, action, limit = 5_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(label + " timed out");
          error.code = "SC010_VERIFY_TIMEOUT";
          reject(error);
        }, limit);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function connect() {
  if (browser) {
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1_000))
    ]).catch(() => {});
  }
  browser = await bounded("connectOverCDP", () => chromium.connectOverCDP(cdpUrl), 6_000);
}

async function readState() {
  const raw = await fs.readFile(statePath, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

function ageSeconds(iso) {
  const at = new Date(String(iso || ""));
  if (!Number.isFinite(at.getTime())) return 0;
  return Math.max(0, (Date.now() - at.getTime()) / 1000);
}

async function inspectConversation(page) {
  return bounded("conversation evaluate", () => page.evaluate(() => {
    const normalize = (value) => String(value || "")
      .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const legacyUser = Array.from(document.querySelectorAll('main [data-message-author-role="user"]'));
    const modernUser = Array.from(document.querySelectorAll("main .text-size-chat.whitespace-pre-wrap"))
      .filter((node) => !node.closest?.("#prompt-textarea,[contenteditable='true'],textarea"));
    const userNodes = legacyUser.length ? legacyUser : [...new Set(modernUser)];

    const legacyAssistant = Array.from(document.querySelectorAll('main [data-message-author-role="assistant"]'));
    const modernAssistant = Array.from(document.querySelectorAll("main [class*='MarkdownRoot-']"));
    const assistantNodes = legacyAssistant.length ? legacyAssistant : [...new Set(modernAssistant)];

    const userTexts = userNodes.map((node) => normalize(node.innerText || node.textContent || "")).filter(Boolean);
    const assistantTexts = assistantNodes.map((node) => normalize(node.innerText || node.textContent || "")).filter(Boolean);
    const re = /MAGASIN_CYCLE_CORRELATION_V1\s+([A-Za-z0-9._:-]+)/g;

    const collect = (texts) => {
      const counts = new Map();
      for (const text of texts) {
        const ids = new Set();
        for (const match of text.matchAll(re)) ids.add(match[1]);
        for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
      }
      return Object.fromEntries(counts);
    };

    return {
      path: location.pathname,
      user_counts: collect(userTexts),
      assistant_counts: collect(assistantTexts),
      user_turn_count: userTexts.length,
      assistant_turn_count: assistantTexts.length
    };
  }), 5_000);
}

await connect();
try {
  while (Date.now() <= deadline) {
    const state = await readState().catch(() => null);
    if (state) {
      const updated = new Date(String(state.updated_at || ""));
      if (Number.isFinite(updated.getTime()) && updated > startedAt) candidateStateObserved = true;

      if (candidateStateObserved && String(state.automation?.phase || "") === "NEXT_WORK") {
        const age = ageSeconds(state.updated_at);
        maxNextWorkAge = Math.max(maxNextWorkAge, age);
        if (age > 45) {
          console.log("SC010_LIVE_NEXT_WORK_STALL_SECONDS=" + Math.floor(age));
          throw new Error("NEXT_WORK remained stale for more than 45 seconds");
        }
      }
    }

    let pages;
    try {
      pages = browser.contexts().flatMap((context) => context.pages()).filter((page) => {
        try {
          const host = new URL(page.url()).hostname;
          return host === "chatgpt.com" || host.endsWith(".chatgpt.com");
        } catch {
          return false;
        }
      });
    } catch {
      await connect();
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }

    if (pages.length === 1) {
      try {
        const proof = await inspectConversation(pages[0]);
        const userCounts = proof.user_counts || {};
        const assistantCounts = proof.assistant_counts || {};

        for (const [id, count] of Object.entries(userCounts)) {
          if (Number(count) > 1) throw new Error("duplicate Robot user correlation detected: " + id);
        }

        const completed = Object.keys(userCounts).filter((id) =>
          Number(userCounts[id]) === 1 && Number(assistantCounts[id] || 0) >= 1
        );

        if (completed.length >= 5 && state) {
          const lastVerified = new Date(String(state.source_of_truth?.last_verified_at || ""));
          if (Number.isFinite(lastVerified.getTime()) && lastVerified > startedAt) {
            const selected = completed.slice(-5);
            selected.forEach((id, index) => {
              console.log(`SC010_LIVE_CYCLE_${index + 1}_CORRELATION=${id}`);
            });
            console.log("SC010_LIVE_VERIFIED_CYCLE_COUNT=" + completed.length);
            console.log("SC010_LIVE_CHATGPT_PAGE_COUNT=1");
            console.log("SC010_LIVE_CHAT_PATH=" + proof.path);
            console.log("SC010_LIVE_USER_TURN_COUNT=" + proof.user_turn_count);
            console.log("SC010_LIVE_ASSISTANT_TURN_COUNT=" + proof.assistant_turn_count);
            console.log("SC010_LIVE_MAX_NEXT_WORK_AGE_SECONDS=" + Math.floor(maxNextWorkAge));
            console.log("SC010_LIVE_EXACT_ONCE_DOM=True");
            console.log("SC010_LIVE_FIVE_SEQUENTIAL_CYCLES=True");
            console.log("SC010_LIVE_NO_NEXT_WORK_STALL=True");
            process.exit(0);
          }
        }
      } catch (error) {
        if (/duplicate Robot user correlation/.test(String(error?.message || ""))) throw error;
        if (error?.code === "SC010_VERIFY_TIMEOUT") {
          await connect().catch(() => {});
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("five completed correlated cycles were not observed before timeout");
} finally {
  if (browser) {
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1_500))
    ]).catch(() => {});
  }
}
