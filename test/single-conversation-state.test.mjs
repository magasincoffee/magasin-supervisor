import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  SINGLE_CONVERSATION_MODE,
  createSingleConversationState,
  ensureSingleConversationState,
  readSingleConversationState,
  writeSingleConversationState,
  markSourceOfTruthVerified,
  beginConversationGeneration,
  retireConversation
} from "../src/runtime/single-conversation-state.mjs";

async function tempStatePath() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-sc002-"));
  return {
    root,
    statePath: path.join(root, "single-conversation-state.json")
  };
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("SC-002 state is created from Source of Truth only", () => {
  const state = createSingleConversationState({
    sourceOfTruthUrl: "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md",
    projectId: "LIVE",
    sessionId: "session-1",
    now: () => "2026-09-28T11:30:00.000Z"
  });

  assert.equal(state.mode, SINGLE_CONVERSATION_MODE);
  assert.equal(state.project_id, "LIVE");
  assert.equal(
    state.source_of_truth.url,
    "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md"
  );
  assert.equal(state.conversation.generation, 0);
  assert.equal(state.conversation.runtime_id, null);
  assert.equal(state.conversation.page_id, null);
  assert.equal(state.outbound.state, "NONE");
  assert.equal(state.outbound.cmd_id, null);
  assert.equal(state.external_work.task_id, null);
  assert.equal(state.external_work.workflow_run_id, null);
  assert.equal(state.external_work.repair_attempt, 0);
  assert.equal(state.external_work.max_repair_attempts, 3);
  assert.deepEqual(state.external_work.history, []);
  assert.equal(state.automation.wait_kind, null);
  assert.equal(state.automation.wait_label, null);
  assert.equal(state.automation.wait_task_id, null);
  assert.equal(state.automation.wait_started_at, null);
  assert.equal(state.automation.wait_until, null);
  assert.equal(state.automation.wait_seconds_total, 0);
  assert.equal(Object.hasOwn(state, "planner"), false);
  assert.equal(Object.hasOwn(state, "executor"), false);
  assert.equal(Object.hasOwn(state.conversation, "url"), false);
  assert.equal(Object.hasOwn(state.conversation, "target"), false);
});

test("SC-002 persisted state rejects Planner Executor targets and conversation URLs", async () => {
  const { root, statePath } = await tempStatePath();
  try {
    const state = createSingleConversationState({
      sourceOfTruthUrl: "https://example.com/source",
      sessionId: "session-2"
    });
    state.planner = { target: "https://chatgpt.com/c/planner" };
    await assert.rejects(
      writeSingleConversationState(statePath, state),
      /persistent conversation targets are forbidden/
    );

    delete state.planner;
    state.conversation.url = "https://chatgpt.com/c/123";
    await assert.rejects(
      writeSingleConversationState(statePath, state),
      /persistent conversation targets are forbidden/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-002 ensure creates and reopens the same Source of Truth state", async () => {
  const { root, statePath } = await tempStatePath();
  try {
    const first = await ensureSingleConversationState(statePath, {
      sourceOfTruthUrl: "https://example.com/project/source",
      sessionId: "session-3",
      now: () => "2026-09-28T11:31:00.000Z"
    });
    const second = await ensureSingleConversationState(statePath, {
      sourceOfTruthUrl: "https://example.com/project/source"
    });

    assert.equal(second.session_id, first.session_id);
    assert.equal(second.source_of_truth.url, first.source_of_truth.url);
    assert.equal(second.conversation.generation, 0);

    await assert.rejects(
      ensureSingleConversationState(statePath, {
        sourceOfTruthUrl: "https://example.com/other/source"
      }),
      /different Source of Truth/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-002 conversation generation is sequential and disposable", async () => {
  const { root, statePath } = await tempStatePath();
  try {
    await ensureSingleConversationState(statePath, {
      sourceOfTruthUrl: "https://example.com/source",
      sessionId: "session-4"
    });

    const first = await beginConversationGeneration(statePath, {
      runtimeId: "bridge-page-1",
      pageId: "cdp-page-1",
      at: () => "2026-09-28T11:32:00.000Z"
    });
    assert.equal(first.conversation.generation, 1);
    assert.equal(first.conversation.status, "ACTIVE");
    assert.equal(first.automation.phase, "SYNC_SOURCE_OF_TRUTH");

    const retired = await retireConversation(statePath, {
      reason: "UNUSABLE",
      at: () => "2026-09-28T11:33:00.000Z"
    });
    assert.equal(retired.conversation.status, "RETIRED");
    assert.equal(retired.conversation.runtime_id, null);
    assert.equal(retired.conversation.page_id, null);
    assert.equal(retired.automation.phase, "NEW_CHAT");

    const second = await beginConversationGeneration(statePath, {
      runtimeId: "bridge-page-2",
      pageId: "cdp-page-2",
      at: () => "2026-09-28T11:34:00.000Z"
    });
    assert.equal(second.conversation.generation, 2);
    assert.equal(second.conversation.runtime_id, "bridge-page-2");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-002 Source of Truth verification is explicit runtime metadata only", async () => {
  const { root, statePath } = await tempStatePath();
  try {
    await ensureSingleConversationState(statePath, {
      sourceOfTruthUrl: "https://example.com/source",
      sessionId: "session-5"
    });
    const state = await markSourceOfTruthVerified(statePath, {
      revision: "abc123",
      at: () => "2026-09-28T11:35:00.000Z"
    });

    assert.equal(state.source_of_truth.sync_status, "VERIFIED");
    assert.equal(state.source_of_truth.last_revision, "abc123");
    assert.equal(
      state.source_of_truth.last_verified_at,
      "2026-09-28T11:35:00.000Z"
    );
    assert.equal(Object.hasOwn(state, "project_progress"), false);
    assert.equal(Object.hasOwn(state, "active_task_id"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-002 state CLI starts with Source of Truth and no chat URLs", async () => {
  const { root, statePath } = await tempStatePath();
  const cli = new URL(
    "../src/runtime/single-conversation-state-cli.mjs",
    import.meta.url
  );
  try {
    const result = await runNode([
      fileURLToPath(cli),
      "--state", statePath,
      "--source-of-truth", "https://example.com/source"
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /SINGLE_CONVERSATION_STATE=READY/);
    assert.match(result.stdout, /SINGLE_CONVERSATION_MODE=SINGLE_CONVERSATION_V1/);
    assert.match(result.stdout, /SINGLE_CONVERSATION_CHAT_URL_REQUIRED=False/);
    assert.match(result.stdout, /SINGLE_CONVERSATION_PLANNER_URL_REQUIRED=False/);
    assert.match(result.stdout, /SINGLE_CONVERSATION_EXECUTOR_URL_REQUIRED=False/);

    const durable = await readSingleConversationState(statePath);
    assert.equal(durable.source_of_truth.url, "https://example.com/source");
    assert.equal(Object.hasOwn(durable, "planner"), false);
    assert.equal(Object.hasOwn(durable, "executor"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
