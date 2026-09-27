import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

import {
  ChatGptUiAdapter,
  defaultSupervisorProfileDir
} from "../ui/playwright-adapter.mjs";
import { runPe001LiveQualification } from "./planner-executor-qualification.mjs";

function parseArgs(argv) {
  const args = {
    execute: false,
    keepChats: false,
    stateRoot: "",
    profileDir: "",
    timeoutMs: 120_000
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--execute") args.execute = true;
    else if (token === "--keep-chats") args.keepChats = true;
    else if (token === "--state-root") args.stateRoot = argv[++index] || "";
    else if (token === "--profile-dir") args.profileDir = argv[++index] || "";
    else if (token === "--timeout-ms") {
      args.timeoutMs = Math.max(30_000, Number(argv[++index] || 120_000));
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return args;
}

function defaultStateRoot(env = process.env) {
  if (String(env.SUPERVISOR_STATE_ROOT || "").trim()) {
    return path.resolve(String(env.SUPERVISOR_STATE_ROOT).trim());
  }
  const base = env.LOCALAPPDATA || env.HOME || process.cwd();
  return path.join(base, "MAGASIN", "BusinessOS", "supervisor");
}

async function processExists(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function assertPe001QualificationSafeWindow(stateRoot) {
  const pidPath = path.join(stateRoot, "supervisor.pid");
  try {
    const raw = await fs.readFile(pidPath, "utf8");
    const pid = Number(String(raw || "").trim());
    if (await processExists(pid)) {
      const error = new Error(
        `live Supervisor PID ${pid} is active; PE-001 qualification refuses concurrent browser mutation`
      );
      error.code = "LIVE_SUPERVISOR_ACTIVE";
      throw error;
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stateRoot = path.resolve(args.stateRoot || defaultStateRoot());
  const profileDir = path.resolve(
    args.profileDir || defaultSupervisorProfileDir()
  );

  if (!args.execute) {
    process.stdout.write(JSON.stringify({
      schema_version: "pe001-live-qualification-preflight.v1",
      execute: false,
      state_root: stateRoot,
      profile_dir: profileDir,
      requires: [
        "--execute",
        "MAGASIN_PE001_LIVE_QUALIFICATION=YES",
        "no live Supervisor PID",
        "authenticated normal ChatGPT session in dedicated profile"
      ]
    }, null, 2) + "\n");
    return;
  }

  if (process.env.MAGASIN_PE001_LIVE_QUALIFICATION !== "YES") {
    throw new Error(
      "live qualification requires MAGASIN_PE001_LIVE_QUALIFICATION=YES"
    );
  }

  await assertPe001QualificationSafeWindow(stateRoot);

  const runId = `pe001-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const diagnosticsDir = path.join(
    stateRoot,
    "diagnostics",
    "pe001-qualification",
    runId
  );
  await fs.mkdir(diagnosticsDir, { recursive: true });
  const statePath = path.join(diagnosticsDir, "state.json");
  const summaryPath = path.join(diagnosticsDir, "summary.json");

  const adapter = new ChatGptUiAdapter({
    profileDir,
    url: "https://chatgpt.com/",
    headless: false,
    timeoutMs: args.timeoutMs,
    actionTimeoutMs: 10_000,
    settleMs: 2_000
  });

  let plannerPage = null;
  let executorPage = null;
  try {
    plannerPage = await adapter.open();

    // Qualification uses exactly the root page opened by the isolated
    // persistent context plus one additional normal ChatGPT page.
    executorPage = await adapter.newChatPage("https://chatgpt.com/");

    const controlledPages = [plannerPage, executorPage]
      .filter((page) => page && !page.isClosed());
    if (controlledPages.length !== 2) {
      throw new Error("qualification did not acquire exactly two controlled ChatGPT pages");
    }

    const result = await runPe001LiveQualification({
      statePath,
      plannerPage,
      executorPage
    });

    const summary = {
      ...result,
      run_id: runId,
      completed_at: new Date().toISOString(),
      production_cutover: false,
      note:
        "Temporary normal ChatGPT qualification chats only; no ChatGPT Work mode."
    };
    await fs.writeFile(
      summaryPath,
      JSON.stringify(summary, null, 2) + "\n",
      "utf8"
    );
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } finally {
    if (!args.keepChats) {
      if (executorPage && !executorPage.isClosed()) {
        await adapter.closePage(executorPage).catch(() => {});
      }
      if (plannerPage && !plannerPage.isClosed()) {
        await adapter.closePage(plannerPage).catch(() => {});
      }
    }
    await adapter.close().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      schema_version: "pe001-live-qualification-error.v1",
      status: "BLOCKED",
      error_code: error?.code || "QUALIFICATION_ERROR",
      reason: String(error?.message || error).slice(0, 500)
    }) + "\n"
  );
  process.exitCode = 1;
});
