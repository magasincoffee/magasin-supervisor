import process from "node:process";
import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import { captureLatestRoleTurn } from "../../src/ui/latest-turn.mjs";

if (String(process.env.COMPUTERNAME || "").toUpperCase() !== "DESKTOP-4K7IM13") {
  console.log("SC010_NODE_PROBE_TARGET_MATCH=False");
  process.exit(0);
}

async function findCdp() {
  for (let port = 9222; port <= 9232; port += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (!res.ok) continue;
      const body = await res.json();
      if (body?.webSocketDebuggerUrl) return `http://127.0.0.1:${port}`;
    } catch {}
  }
  return null;
}

async function bounded(label, fn, timeoutMs = 5000) {
  const started = Date.now();
  const timeout = new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), timeoutMs);
    t.unref?.();
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(fn).then((value) => ({ value })),
      timeout
    ]);
    console.log(`SC010_NODE_${label}_MS=${Date.now() - started}`);
    if (result?.timeout) {
      console.log(`SC010_NODE_${label}=TIMEOUT`);
      return null;
    }
    console.log(`SC010_NODE_${label}=PASS`);
    return result.value;
  } catch (error) {
    console.log(`SC010_NODE_${label}=ERROR`);
    console.log(`SC010_NODE_${label}_ERROR=${error?.name || "Error"}`);
    return null;
  }
}

const cdpUrl = await findCdp();
console.log("SC010_NODE_PROBE_TARGET_MATCH=True");
console.log("SC010_NODE_CDP_URL_FOUND=" + Boolean(cdpUrl));
if (!cdpUrl) process.exit(2);

const adapter = new ChatGptUiAdapter({
  cdpUrl,
  settleMs: 100,
  actionTimeoutMs: 3000,
  timeoutMs: 5000
});

let exitCode = 0;
try {
  await bounded("ADAPTER_OPEN", () => adapter.open(), 5000);
  const page = adapter.getActivePage();
  console.log("SC010_NODE_ACTIVE_PAGE=" + Boolean(page));
  if (!page) {
    exitCode = 3;
  } else {
    const snapshot = await bounded("PROBE_PAGE", () => adapter.probePage(page), 5000);
    if (snapshot?.snapshot) {
      console.log("SC010_NODE_PROBE_COMPOSER_READY=" + Boolean(snapshot.snapshot.composerReady));
      console.log("SC010_NODE_PROBE_RESPONSE_RUNNING=" + Boolean(snapshot.snapshot.responseRunning));
      console.log("SC010_NODE_PROBE_LAST_ROLE=" + String(snapshot.snapshot.lastMessageRole || ""));
      console.log("SC010_NODE_PROBE_USER_COUNT=" + String(snapshot.snapshot.userMessageCount ?? ""));
      console.log("SC010_NODE_PROBE_ASSISTANT_COUNT=" + String(snapshot.snapshot.assistantMessageCount ?? ""));
    }
    const assistant = await bounded(
      "CAPTURE_ASSISTANT",
      () => captureLatestRoleTurn(page, "assistant"),
      5000
    );
    console.log("SC010_NODE_ASSISTANT_PRESENT=" + Boolean(assistant?.text));
    await bounded("WAIT_2S", () => page.waitForTimeout(2000), 3500);
  }
} finally {
  await bounded("ADAPTER_CLOSE", () => adapter.close(), 1500);
}
process.exit(exitCode);
