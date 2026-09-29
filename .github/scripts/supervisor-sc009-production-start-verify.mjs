import process from "node:process";
import { chromium } from "playwright-core";

const cdpUrl = String(process.argv[2] || "").trim();
const sourceOfTruthUrl = String(process.argv[3] || "").trim();
const timeoutMs = Number(process.argv[4] || 120000);

if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl)) {
  throw new Error("local CDP URL is required");
}
if (!/^https:\/\//.test(sourceOfTruthUrl)) {
  throw new Error("Source of Truth URL is required");
}

const browser = await chromium.connectOverCDP(cdpUrl);
const deadline = Date.now() + timeoutMs;
let last = null;

while (Date.now() <= deadline) {
  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());
  for (const page of pages) {
    let host = "";
    try {
      host = new URL(page.url()).hostname;
    } catch {}
    if (host !== "chatgpt.com" && !host.endsWith(".chatgpt.com")) continue;

    const proof = await page.evaluate((sot) => {
      const clean = (value) => String(value || "")
        .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const main = document.querySelector("main");
      const mainText = clean(main?.innerText || main?.textContent || "");
      const bootstrap =
        mainText.includes("MAGASIN_SINGLE_CONVERSATION_BOOTSTRAP_V1") &&
        mainText.includes("SOT=" + sot);

      const assistantSemantic = Array.from(
        document.querySelectorAll('main [data-message-author-role="assistant"]')
      ).map((node) => clean(node.innerText || node.textContent || ""))
        .filter(Boolean);

      const markdown = Array.from(
        document.querySelectorAll("main [class*='MarkdownRoot-']")
      ).map((node) => clean(node.innerText || node.textContent || ""))
        .filter(Boolean);

      return {
        bootstrap,
        assistant: assistantSemantic.length > 0 || markdown.length > 0,
        assistant_count: assistantSemantic.length,
        markdown_count: markdown.length,
        user_count: document.querySelectorAll(
          'main [data-message-author-role="user"]'
        ).length,
        url: location.href
      };
    }, sourceOfTruthUrl).catch(() => null);

    if (proof) {
      last = proof;
      if (proof.bootstrap && proof.assistant) {
        console.log("SC009_LIVE_BOOTSTRAP_VISIBLE=True");
        console.log("SC009_LIVE_ASSISTANT_RESPONSE_VISIBLE=True");
        console.log("SC009_LIVE_CHAT_PATH=" + new URL(proof.url).pathname);
        console.log("SC009_LIVE_ASSISTANT_COUNT=" + proof.assistant_count);
        console.log("SC009_LIVE_MARKDOWN_COUNT=" + proof.markdown_count);
        process.exit(0);
      }
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
}

console.log("SC009_LIVE_BOOTSTRAP_VISIBLE=" + Boolean(last?.bootstrap));
console.log("SC009_LIVE_ASSISTANT_RESPONSE_VISIBLE=" + Boolean(last?.assistant));
throw new Error("production START did not yield visible bootstrap plus assistant response");
