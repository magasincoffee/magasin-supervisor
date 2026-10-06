import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  inspectTrackedGitHubRun,
  nextLocalMonitorSeconds,
  trackedGitHubRunDescriptor
} from "../src/runtime/external-run-local-observer.mjs";
import {
  waitForTaskRecheckDelay
} from "../src/runtime/single-conversation-cli.mjs";
import {
  buildSingleConversationTaskInstruction
} from "../src/runtime/single-conversation-loop.mjs";
import {
  ensureSingleConversationState,
  readSingleConversationState,
  writeSingleConversationState
} from "../src/runtime/single-conversation-state.mjs";

function activeExternal(overrides = {}) {
  return {
    task_id: "XSTORE-019B",
    checkpoint_id: "XSTORE-019B-REPAIR-4",
    repo: "magasincoffee/magasincoffee.github.io",
    commit_sha: "ffe5524f415c303951ff23717a833b7597ea524b",
    workflow_run_id: "37337050485",
    workflow_name: "XSTORE_019B_Direct_Calendar_Editing_QA",
    workflow_status: "in_progress",
    workflow_conclusion: null,
    authoritative_sha: "ffe5524f415c303951ff23717a833b7597ea524b",
    run_authority: "AUTHORITATIVE",
    ...overrides
  };
}

function githubResponse({
  status = "in_progress",
  conclusion = null,
  headSha = "ffe5524f415c303951ff23717a833b7597ea524b"
} = {}) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        status,
        conclusion,
        head_sha: headSha,
        updated_at: "2026-10-05T15:57:51Z"
      };
    }
  };
}

test("tracked GitHub run descriptor requires authoritative active run metadata", () => {
  assert.deepEqual(trackedGitHubRunDescriptor(activeExternal()), {
    repo: "magasincoffee/magasincoffee.github.io",
    run_id: "37337050485",
    tracked_status: "in_progress",
    authoritative_sha: "ffe5524f415c303951ff23717a833b7597ea524b"
  });
  assert.equal(
    trackedGitHubRunDescriptor(activeExternal({ run_authority: "OBSOLETE" })),
    null
  );
  assert.equal(
    trackedGitHubRunDescriptor(activeExternal({ workflow_status: "completed" })),
    null
  );
});

test("local observer distinguishes active, terminal, obsolete, and unavailable runs", async () => {
  const active = await inspectTrackedGitHubRun({
    externalWork: activeExternal(),
    token: "",
    fetchImpl: async () => githubResponse()
  });
  assert.equal(active.supported, true);
  assert.equal(active.active, true);
  assert.equal(active.terminal, false);
  assert.equal(active.authority, "AUTHORITATIVE");

  const terminal = await inspectTrackedGitHubRun({
    externalWork: activeExternal(),
    token: "",
    fetchImpl: async () => githubResponse({
      status: "completed",
      conclusion: "success"
    })
  });
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.active, false);
  assert.equal(terminal.conclusion, "success");

  const obsolete = await inspectTrackedGitHubRun({
    externalWork: activeExternal(),
    token: "",
    fetchImpl: async () => githubResponse({
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    })
  });
  assert.equal(obsolete.authority, "OBSOLETE");
  assert.equal(obsolete.terminal, true);

  const unavailable = await inspectTrackedGitHubRun({
    externalWork: activeExternal(),
    token: "",
    fetchImpl: async () => ({ ok: false, status: 403 })
  });
  assert.equal(unavailable.supported, false);
  assert.equal(unavailable.reason, "HTTP_403");
});

test("terminal tracked run waits locally while sibling workflows on the authoritative SHA are active", async () => {
  let call = 0;
  const observed = await inspectTrackedGitHubRun({
    externalWork: activeExternal(),
    token: "",
    fetchImpl: async () => {
      call += 1;
      if (call === 1) {
        return githubResponse({ status: "completed", conclusion: "failure" });
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            workflow_runs: [
              {
                id: 37337050485,
                status: "completed",
                conclusion: "failure",
                head_sha: "ffe5524f415c303951ff23717a833b7597ea524b"
              },
              {
                id: 37337050486,
                status: "in_progress",
                conclusion: null,
                head_sha: "ffe5524f415c303951ff23717a833b7597ea524b"
              }
            ]
          };
        }
      };
    }
  });

  assert.equal(observed.supported, true);
  assert.equal(observed.authority, "AUTHORITATIVE");
  assert.equal(observed.tracked_run_terminal, true);
  assert.equal(observed.run_set_supported, true);
  assert.equal(observed.active, true);
  assert.equal(observed.terminal, false);
  assert.equal(observed.status, "aggregate_in_progress");
  assert.equal(observed.run_set_active_count, 1);
  assert.equal(observed.run_set_failure_count, 1);
});

test("terminal tracked run wakes once all authoritative-SHA sibling workflows are terminal", async () => {
  let call = 0;
  const observed = await inspectTrackedGitHubRun({
    externalWork: activeExternal(),
    token: "",
    fetchImpl: async () => {
      call += 1;
      if (call === 1) {
        return githubResponse({ status: "completed", conclusion: "failure" });
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            workflow_runs: [
              {
                id: 37337050485,
                status: "completed",
                conclusion: "failure",
                head_sha: "ffe5524f415c303951ff23717a833b7597ea524b"
              },
              {
                id: 37337050486,
                status: "completed",
                conclusion: "success",
                head_sha: "ffe5524f415c303951ff23717a833b7597ea524b"
              }
            ]
          };
        }
      };
    }
  });

  assert.equal(observed.supported, true);
  assert.equal(observed.authority, "AUTHORITATIVE");
  assert.equal(observed.run_set_supported, true);
  assert.equal(observed.active, false);
  assert.equal(observed.terminal, true);
  assert.equal(observed.run_set_active_count, 0);
  assert.equal(observed.run_set_failure_count, 1);
});

test("local monitor cadence is bounded", () => {
  assert.equal(nextLocalMonitorSeconds(1), 20);
  assert.equal(nextLocalMonitorSeconds(2), 30);
  assert.equal(nextLocalMonitorSeconds(3), 30);
  assert.equal(nextLocalMonitorSeconds(99), 30);
});

test("RUNNING wait suppresses redundant ChatGPT CHECK turns until tracked GitHub run becomes terminal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "smart-check-"));
  const statePath = path.join(root, "state.json");
  let clock = 0;
  let fetchCount = 0;
  let recoveryCount = 0;

  try {
    const state = await ensureSingleConversationState(statePath, {
      sourceOfTruthUrl: "https://github.com/magasincoffee/magasincoffee.github.io/blob/main/01_DOCS/MAGASIN/05_SYSTEM/WORKFORCE_CROSS_STORE_SCHEDULING_TEMP_SOURCE_OF_TRUTH.md",
      sessionId: "smart-check"
    });
    state.external_work = {
      ...state.external_work,
      ...activeExternal()
    };
    await writeSingleConversationState(statePath, state);

    const sequence = [
      githubResponse(),
      githubResponse(),
      githubResponse({ status: "completed", conclusion: "success" })
    ];

    const result = await waitForTaskRecheckDelay({
      adapter: {},
      page: { id: "fake-page" },
      statePath,
      sourceOfTruthUrl: state.source_of_truth.url,
      taskId: "XSTORE-019B",
      seconds: 20,
      pollMs: 2_000,
      localMonitorMaxSeconds: 300,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      recoveryProbe: async ({ page }) => {
        recoveryCount += 1;
        return { page, recovered: false };
      },
      fetchImpl: async () => {
        const next = sequence[Math.min(fetchCount, sequence.length - 1)];
        fetchCount += 1;
        return next;
      }
    });

    assert.equal(result.wake_reason, "LOCAL_EXTERNAL_TERMINAL");
    assert.equal(result.local_external_checks, 3);
    assert.equal(fetchCount, 4);
    assert.ok(recoveryCount > 0);
    assert.equal(clock, 70_000);

    const restored = await readSingleConversationState(statePath);
    assert.equal(restored.external_work.task_id, "XSTORE-019B");
    assert.equal(restored.external_work.workflow_run_id, "37337050485");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("local observer failure falls back to normal CHECK at original deadline", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "smart-check-fallback-"));
  const statePath = path.join(root, "state.json");
  let clock = 0;

  try {
    const state = await ensureSingleConversationState(statePath, {
      sourceOfTruthUrl: "https://example.com/SOT.md",
      sessionId: "smart-check-fallback"
    });
    state.external_work = {
      ...state.external_work,
      ...activeExternal()
    };
    await writeSingleConversationState(statePath, state);

    const result = await waitForTaskRecheckDelay({
      adapter: {},
      page: {},
      statePath,
      sourceOfTruthUrl: state.source_of_truth.url,
      taskId: "XSTORE-019B",
      seconds: 20,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      recoveryProbe: async ({ page }) => ({ page, recovered: false }),
      fetchImpl: async () => ({ ok: false, status: 403 })
    });

    assert.equal(result.wake_reason, "CHECK_AFTER_DEADLINE");
    assert.equal(result.local_external_checks, 1);
    assert.equal(clock, 20_000);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("repeated CHECK prompt stays compact while preserving the existing machine protocol", () => {
  const prompt = buildSingleConversationTaskInstruction({
    sourceOfTruthUrl: "https://example.com/SOT.md",
    taskId: "XSTORE-019B",
    messageId: "compact-check",
    checkOnly: true
  });
  assert.match(prompt, /^MAGASIN_CHECK_TASK_V1/m);
  assert.match(prompt, /STATUS=<READY\|RUNNING\|COMPLETE\|BLOCKED\|DONE>/);
  assert.match(prompt, /MAGASIN_EXTERNAL_RUN_V1/);
  assert.match(prompt, /completed failure => READY for this same task\/AUTO_REPAIR/i);
  assert.match(prompt, /MAGASIN_CYCLE_CORRELATION_V1 compact-check/);
  assert.doesNotMatch(prompt, /Choose CHECK_AFTER_SECONDS from the actual active external state/);
  assert.ok(prompt.length < 4200, `CHECK prompt unexpectedly large: ${prompt.length}`);
});
