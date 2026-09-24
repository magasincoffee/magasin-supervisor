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
try {
  const page = await adapter.newChatPage("https://chatgpt.com/");
  const sent = await sendComposerInstruction(page, prompt, { dryRun: false });
  if (!sent?.executed) throw new Error("P2 Brain fixture prompt was not executed");

  await page.waitForURL(
    (value) => isPersistableConversationUrl(String(value)),
    { timeout: 45_000 }
  );
  const target = targetFromUrl(page.url());
  const brainPathKind = target.pathname.startsWith("/c/")
    ? "C"
    : (target.pathname.startsWith("/g/") ? "G" : "PROJECT");

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

  const brainUrl = `${target.origin}${target.pathname}`;
  await fs.writeFile(outputFile, JSON.stringify({
    schema_version: "p2-live-fixture.v1",
    brain_url: brainUrl,
    task_id: directive.task_id,
    directive_digest: directive.digest,
    instruction_digest: directive.instruction_digest
  }, null, 2) + "\n", "utf8");

  console.log("LIVE_P2_FIXTURE_BRAIN_CREATED=True");
  console.log("LIVE_P2_FIXTURE_BRAIN_SPECIFIC_CONVERSATION=True");
  console.log(`LIVE_P2_FIXTURE_BRAIN_PATH_KIND=${brainPathKind}`);
  console.log(`LIVE_P2_FIXTURE_TASK_ID=${directive.task_id}`);
  console.log("LIVE_P2_FIXTURE_DIRECTIVE_VALID=True");
} finally {
  await adapter.close().catch(() => {});
}
