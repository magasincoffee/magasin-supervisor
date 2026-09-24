import fs from "node:fs/promises";
import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import { sendComposerInstruction } from "../../src/ui/actions.mjs";
import { captureCompletedAssistantTurn } from "../../src/ui/message-capture.mjs";
import { isPersistableConversationUrl, targetFromUrl } from "../../src/runtime/recovery.mjs";
import { parseLaneDirective } from "../../src/runtime/three-lane.mjs";

const cdpUrl = String(process.env.P2_CDP_URL || "").trim();
const outputFile = String(process.env.P2_FIXTURE_FILE || "").trim();
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

async function exactFixtureDirective(page) {
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
  console.log(`LIVE_P2_FIXTURE_BRAIN_REUSED=${reused ? "True" : "False"}`);
  console.log("LIVE_P2_FIXTURE_BRAIN_CREATED=True");
  console.log("LIVE_P2_FIXTURE_BRAIN_SPECIFIC_CONVERSATION=True");
  console.log(`LIVE_P2_FIXTURE_BRAIN_PATH_KIND=${brainPathKind}`);
  console.log(`LIVE_P2_FIXTURE_TASK_ID=${directive.task_id}`);
  console.log("LIVE_P2_FIXTURE_DIRECTIVE_VALID=True");
}

try {
  const candidatePages = [...adapter.getChatGptPages()];
  const active = adapter.getActivePage();
  const recentUrls = active
    ? await adapter.listRecentConversationUrls(active, { limit: 16 }).catch(() => [])
    : [];
  for (const url of recentUrls) {
    if (candidatePages.length >= 24) break;
    let target = null;
    try { target = targetFromUrl(url); } catch { continue; }
    if (adapter.findPageForTarget(target)) continue;
    const page = await adapter.newChatPage(url).catch(() => null);
    if (page) candidatePages.push(page);
  }
  for (const page of candidatePages) {
    if (!isPersistableConversationUrl(page.url())) continue;
    const directive = await exactFixtureDirective(page);
    if (directive) {
      await persistFixture(page, directive, true);
      await adapter.close().catch(() => {});
      process.exit(0);
    }
  }

  const page = await adapter.newChatPage("https://chatgpt.com/");
  const sent = await sendComposerInstruction(page, prompt, { dryRun: false });
  if (!sent?.executed) throw new Error("P2 Brain fixture prompt was not executed");

  await page.waitForURL(
    (value) => isPersistableConversationUrl(String(value)),
    { timeout: 45_000 }
  );
  const target = targetFromUrl(page.url());
  let captured = null;
  let directive = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const probe = await adapter.probePage(page).catch(() => null);
    if (
      probe &&
      !probe.snapshot?.responseRunning &&
      Number(probe.snapshot?.assistantMessageCount || 0) > 0
    ) {
      captured = await captureCompletedAssistantTurn(page).catch(() => null);
      if (captured?.text) {
        try {
          directive = parseLaneDirective(captured.text);
        } catch {
          directive = null;
        }
        if (directive?.action === "WORK" && directive.task_id === taskId) break;
      }
    }
    await page.waitForTimeout(1000);
  }

  if (!directive || directive.action !== "WORK" || directive.task_id !== taskId) {
    throw new Error("P2 Brain fixture did not produce the exact valid WORK directive");
  }

  await persistFixture(page, directive, false);
  await adapter.close().catch(() => {});
  process.exit(0);
} finally {
  await adapter.close().catch(() => {});
}
