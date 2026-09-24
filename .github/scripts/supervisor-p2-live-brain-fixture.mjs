import fs from "node:fs/promises";
import path from "node:path";
import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import { sendComposerInstruction } from "../../src/ui/actions.mjs";
import {
  captureCompletedAssistantTurn,
  captureRecentConversationTurns
} from "../../src/ui/message-capture.mjs";
import { isPersistableConversationUrl, targetFromUrl } from "../../src/runtime/recovery.mjs";
import { parseLaneDirective } from "../../src/runtime/three-lane.mjs";

const cdpUrl = String(process.env.P2_CDP_URL || "").trim();
const outputFile = String(process.env.P2_FIXTURE_FILE || "").trim();
const cacheFile = String(process.env.P2_FIXTURE_CACHE_FILE || "").trim();
const mutationPacingMs = Math.max(
  5_000,
  Number.parseInt(process.env.P2_LIVE_MUTATION_PACING_MS || "5000", 10) || 5_000
);
if (!cdpUrl || !outputFile) throw new Error("P2 live fixture environment is incomplete");

const taskId = "SUP-SELFHEAL-P2-LIVE-FIXTURE";
const instruction = "Return exactly P2_LIVE_WORK_OK. Do not use tools, files, web, external services, or modify any system.";
const prompt = [
  "Acceptance fixture only. Return exactly this machine-readable block and nothing else:",
  "<<<MAGASIN_LANE_DIRECTIVE_V1>>>",
  JSON.stringify({ action: "WORK", task_id: taskId, instruction }),
  "<<<END_MAGASIN_LANE_DIRECTIVE_V1>>>"
].join("\n");

const adapter = new ChatGptUiAdapter({ cdpUrl, timeoutMs: 60_000, settleMs: 800 });
await adapter.open();

function rateLimitError() {
  const error = new Error("CHATGPT_RATE_LIMITED");
  error.code = "CHATGPT_RATE_LIMITED";
  return error;
}

async function assertNotRateLimited(page) {
  const probe = await adapter.probePage(page).catch(() => null);
  if (probe?.snapshot?.rateLimited) throw rateLimitError();
  return probe;
}

async function exactFixtureDirective(page) {
  const turns = await captureRecentConversationTurns(page, { limit: 16 })
    .catch(() => []);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.role !== "assistant" || !turn.text) continue;
    try {
      const directive = parseLaneDirective(turn.text);
      if (
        directive.action === "WORK" &&
        directive.task_id === taskId &&
        directive.instruction === instruction
      ) {
        const newerUserTurn = turns
          .slice(index + 1)
          .some((item) => item.role === "user");
        if (!newerUserTurn) return directive;
      }
    } catch {}
  }

  const captured = await captureCompletedAssistantTurn(page).catch(() => null);
  if (!captured?.text) return null;
  try {
    const directive = parseLaneDirective(captured.text);
    if (
      directive.action === "WORK" &&
      directive.task_id === taskId &&
      directive.instruction === instruction
    ) return directive;
  } catch {}
  return null;
}

function hasConversationIdentity(value) {
  try {
    targetFromUrl(String(value || ""));
    return true;
  } catch {
    return false;
  }
}

async function readFixtureCache() {
  if (!cacheFile) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    if (
      parsed?.schema_version === "p2-live-fixture-cache.v1" &&
      parsed?.task_id === taskId &&
      isPersistableConversationUrl(String(parsed?.brain_url || ""))
    ) {
      return parsed;
    }
  } catch {}
  return null;
}

async function writeFixtureCache(brainUrl) {
  if (!cacheFile) return;
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify({
    schema_version: "p2-live-fixture-cache.v1",
    brain_url: brainUrl,
    task_id: taskId
  }, null, 2) + "\n", "utf8");
}

async function navigateSinglePage(page, url) {
  await new Promise((resolve) => setTimeout(resolve, mutationPacingMs));
  await assertNotRateLimited(page);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });
  await page.waitForTimeout(800);
  await assertNotRateLimited(page);
  return page;
}

async function persistFixture(page, directive, reused) {
  const target = targetFromUrl(page.url());
  const brainPathKind = target.pathname.startsWith("/c/")
    ? "C"
    : (target.pathname.startsWith("/g/") ? "G" : "PROJECT");
  const brainUrl = `${target.origin}${target.pathname}`;
  await fs.writeFile(outputFile, JSON.stringify({
    schema_version: "p2-live-fixture.v1",
    brain_url: brainUrl,
    task_id: directive.task_id,
    directive_digest: directive.digest,
    instruction_digest: directive.instruction_digest
  }, null, 2) + "\n", "utf8");
  await writeFixtureCache(brainUrl);
  console.log(`LIVE_P2_FIXTURE_BRAIN_REUSED=${reused ? "True" : "False"}`);
  console.log("LIVE_P2_FIXTURE_BRAIN_CREATED=True");
  console.log("LIVE_P2_FIXTURE_BRAIN_SPECIFIC_CONVERSATION=True");
  console.log(`LIVE_P2_FIXTURE_BRAIN_PATH_KIND=${brainPathKind}`);
  console.log(`LIVE_P2_FIXTURE_TASK_ID=${directive.task_id}`);
  console.log("LIVE_P2_FIXTURE_DIRECTIVE_VALID=True");
}

async function closeAdapterBounded(timeoutMs = 2_000) {
  let timer = null;
  try {
    await Promise.race([
      adapter.close().catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function finishFixtureSuccess(page, directive, reused) {
  await persistFixture(page, directive, reused);
  await closeAdapterBounded();
  process.exit(0);
}

try {
  const candidatePages = [...adapter.getChatGptPages()];
  const active = adapter.getActivePage();
  for (const page of candidatePages) {
    if (!isPersistableConversationUrl(page.url())) continue;
    const directive = await exactFixtureDirective(page);
    if (directive) {
      await finishFixtureSuccess(page, directive, true);
    }
  }

  let page = active;
  if (!page || page.isClosed()) {
    throw new Error("P2_FIXTURE_ACTIVE_PAGE_MISSING");
  }

  const cache = await readFixtureCache();
  if (cache?.brain_url) {
    await navigateSinglePage(page, cache.brain_url);
    const directive = await exactFixtureDirective(page);
    if (directive) {
      console.log("LIVE_P2_FIXTURE_CACHE_REUSED=True");
      await finishFixtureSuccess(page, directive, true);
    }
  }

  const recentUrls = await adapter.listRecentConversationUrls(page, { limit: 1 })
    .catch(() => []);
  const recentUrl = recentUrls[0] || null;
  if (
    recentUrl &&
    (!cache?.brain_url || recentUrl !== cache.brain_url)
  ) {
    await navigateSinglePage(page, recentUrl);
    const directive = await exactFixtureDirective(page);
    if (directive) {
      console.log("LIVE_P2_FIXTURE_RECENT_SINGLE_REUSED=True");
      await finishFixtureSuccess(page, directive, true);
    }
  }

  let activeIsHome = false;
  try {
    activeIsHome = Boolean(
      page &&
      !page.isClosed() &&
      new URL(page.url()).origin === "https://chatgpt.com" &&
      new URL(page.url()).pathname === "/"
    );
  } catch {
    activeIsHome = false;
  }
  if (!activeIsHome) {
    await navigateSinglePage(page, "https://chatgpt.com/");
  }
  await assertNotRateLimited(page);
  await page.waitForTimeout(mutationPacingMs);
  await assertNotRateLimited(page);
  const sent = await sendComposerInstruction(page, prompt, { dryRun: false });
  if (!sent?.executed) throw new Error("P2 Brain fixture prompt was not executed");

  const conversationDeadline = Date.now() + 45_000;
  while (
    Date.now() < conversationDeadline &&
    !hasConversationIdentity(page.url())
  ) {
    await assertNotRateLimited(page);
    await page.waitForTimeout(1_000);
  }
  await assertNotRateLimited(page);
  if (!hasConversationIdentity(page.url())) {
    const error = new Error("P2_FIXTURE_CONVERSATION_NOT_CONFIRMED");
    error.code = "P2_FIXTURE_CONVERSATION_NOT_CONFIRMED";
    throw error;
  }
  targetFromUrl(page.url());
  let directive = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await assertNotRateLimited(page);
    directive = await exactFixtureDirective(page);
    if (directive) break;
    await page.waitForTimeout(1000);
  }

  if (!directive) {
    throw new Error("P2 Brain fixture did not produce the exact valid WORK directive");
  }

  await finishFixtureSuccess(page, directive, false);
} catch (error) {
  if (error?.code === "CHATGPT_RATE_LIMITED") {
    console.log("LIVE_P2_RATE_LIMIT_DETECTED=True");
    process.exitCode = 75;
  } else {
    throw error;
  }
} finally {
  await closeAdapterBounded();
}
