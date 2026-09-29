import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  markExactOnceResponseComplete,
  markExactOnceVerified,
  prepareExactOnceOutbound,
  reconcileExactOnceOutbound
} from "../src/runtime/single-conversation-transaction.mjs";
import {
  beginConversationGeneration,
  ensureSingleConversationState,
  readSingleConversationState
} from "../src/runtime/single-conversation-state.mjs";
import { composerInstructionDigest } from "../src/ui/actions.mjs";

async function makeState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-sc006-"));
  const statePath = path.join(root, "single-conversation-state.json");
  await ensureSingleConversationState(statePath, {
    sourceOfTruthUrl: "https://example.com/SOURCE_OF_TRUTH.md",
    sessionId: "sc006"
  });
  await beginConversationGeneration(statePath, {
    runtimeId: "chat:x",
    pageId: "page:x"
  });
  return { root, statePath };
}

test("SC-006 persists PREPARED then ENQUEUED receipt before UI send", async () => {
  const { root, statePath } = await makeState();
  const message = "MAGASIN_SINGLE_CONVERSATION_NEXT_V1 id=m1";
  let durableAtSend = null;
  try {
    await prepareExactOnceOutbound(statePath, {
      messageId: "m1",
      message,
      kind: "NEXT",
      baselineUserTurnId: "u0"
    });

    const result = await reconcileExactOnceOutbound({
      statePath,
      page: { async waitForTimeout() {} },
      messageId: "m1",
      message,
      reconciliationProbes: 1,
      inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
      captureTurn: async (_page, role) => {
        if (role !== "user") return null;
        if (durableAtSend) {
          return { turn_id: "u1", text: message, digest: "ignored" };
        }
        return { turn_id: "u0", text: "old", digest: "old" };
      },
      sendInstruction: async () => {
        durableAtSend = await readSingleConversationState(statePath);
        assert.equal(durableAtSend.outbound.state, "ENQUEUED");
        assert.equal(durableAtSend.outbound.cmd_id, "ui:m1");
        return { executed: true };
      }
    });

    assert.equal(result.action, "SEND");
    const durable = await readSingleConversationState(statePath);
    assert.equal(durable.outbound.state, "DELIVERED");
    assert.equal(durable.outbound.cmd_id, "ui:m1");
    assert.equal(durable.outbound.retry_count, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-006 polls delayed post-send user-turn evidence before marking DELIVERED", async () => {
  const { root, statePath } = await makeState();
  const message = "MAGASIN_SINGLE_CONVERSATION_NEXT_V1 id=delayed";
  let sent = false;
  let postSendCaptures = 0;
  try {
    await prepareExactOnceOutbound(statePath, {
      messageId: "delayed",
      message,
      kind: "NEXT",
      baselineUserTurnId: "u0"
    });

    const result = await reconcileExactOnceOutbound({
      statePath,
      page: { async waitForTimeout() {} },
      messageId: "delayed",
      message,
      reconciliationProbes: 3,
      reconciliationPollMs: 1,
      inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
      captureTurn: async (_page, role) => {
        if (role !== "user") return null;
        if (!sent) return { turn_id: "u0", text: "old" };
        postSendCaptures += 1;
        if (postSendCaptures < 3) return { turn_id: "u0", text: "old" };
        return { turn_id: "u1", text: message };
      },
      sendInstruction: async () => {
        sent = true;
        return { executed: true };
      }
    });

    assert.equal(result.action, "SEND");
    assert.ok(postSendCaptures >= 3);
    const durable = await readSingleConversationState(statePath);
    assert.equal(durable.outbound.state, "DELIVERED");
    assert.equal(durable.outbound.delivered_user_turn_id, "u1");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-006 ambiguous post-send evidence is fail-closed across restart", async () => {
  const { root, statePath } = await makeState();
  const message = "MAGASIN_SINGLE_CONVERSATION_NEXT_V1 id=ambiguous";
  let sends = 0;
  try {
    await prepareExactOnceOutbound(statePath, {
      messageId: "ambiguous",
      message,
      kind: "NEXT",
      baselineUserTurnId: "u0"
    });

    await assert.rejects(
      reconcileExactOnceOutbound({
        statePath,
        page: { async waitForTimeout() {} },
        messageId: "ambiguous",
        message,
        reconciliationProbes: 1,
        reconciliationPollMs: 1,
        inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
        captureTurn: async () => ({ turn_id: "u0", text: "old" }),
        sendInstruction: async () => {
          sends += 1;
          return { executed: true };
        }
      }),
      (error) => error?.code === "AMBIGUOUS_POST_SEND_DELIVERY"
    );

    const durable = await readSingleConversationState(statePath);
    assert.equal(durable.outbound.state, "ENQUEUED");
    assert.equal(durable.outbound.last_error_code, "AMBIGUOUS_POST_SEND_DELIVERY");

    await assert.rejects(
      reconcileExactOnceOutbound({
        statePath,
        page: { async waitForTimeout() {} },
        messageId: "ambiguous",
        message,
        reconciliationProbes: 1,
        reconciliationPollMs: 1,
        inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
        captureTurn: async () => ({ turn_id: "u0", text: "old" }),
        sendInstruction: async () => {
          sends += 1;
          return { executed: true };
        }
      }),
      (error) => error?.code === "AMBIGUOUS_POST_SEND_DELIVERY"
    );
    assert.equal(sends, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-006 crash after send reconciles matching user turn without duplicate send", async () => {
  const { root, statePath } = await makeState();
  const message = "MAGASIN_SINGLE_CONVERSATION_NEXT_V1 id=m2";
  let sends = 0;
  try {
    await prepareExactOnceOutbound(statePath, {
      messageId: "m2",
      message,
      kind: "NEXT",
      baselineUserTurnId: "u0"
    });

    // First call reaches ENQUEUED and simulates process death during the UI
    // send before the runtime can mark DELIVERED.
    await assert.rejects(
      reconcileExactOnceOutbound({
        statePath,
        page: { async waitForTimeout() {} },
        messageId: "m2",
        message,
        reconciliationProbes: 1,
        inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
        captureTurn: async () => ({ turn_id: "u0", text: "old" }),
        sendInstruction: async () => {
          sends += 1;
          throw Object.assign(new Error("simulated process death"), {
            code: "SIMULATED_CRASH"
          });
        }
      }),
      /simulated process death/
    );

    const enqueued = await readSingleConversationState(statePath);
    assert.equal(enqueued.outbound.state, "ENQUEUED");
    assert.equal(enqueued.outbound.cmd_id, "ui:m2");

    // On restart the exact user turn is already visible. Reconciliation must
    // mark it DELIVERED and never send again.
    const recovered = await reconcileExactOnceOutbound({
      statePath,
      page: { async waitForTimeout() {} },
      messageId: "m2",
      message,
      reconciliationProbes: 1,
      inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
      captureTurn: async () => ({
        turn_id: "u1",
        text: message,
        digest: composerInstructionDigest(message)
      }),
      sendInstruction: async () => {
        sends += 1;
        return { executed: true };
      }
    });

    assert.equal(recovered.action, "NO_SEND");
    assert.equal(recovered.reason, "matching-user-turn-reconciled");
    assert.equal(sends, 1);
    const durable = await readSingleConversationState(statePath);
    assert.equal(durable.outbound.state, "DELIVERED");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-006 positive non-delivery permits exactly one bounded safe retry", async () => {
  const { root, statePath } = await makeState();
  const message = "MAGASIN_SINGLE_CONVERSATION_NEXT_V1 id=m3";
  let sent = false;
  let sends = 0;
  try {
    await prepareExactOnceOutbound(statePath, {
      messageId: "m3",
      message,
      kind: "NEXT",
      baselineUserTurnId: "u0"
    });

    // Persist ENQUEUED without mutating UI: equivalent to a crash after the
    // durable receipt and before browser actuation.
    await reconcileExactOnceOutbound({
      statePath,
      page: { async waitForTimeout() {} },
      messageId: "m3",
      message,
      reconciliationProbes: 1,
      inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
      captureTurn: async () => sent
        ? { turn_id: "u1", text: message }
        : { turn_id: "u0", text: "old" },
      sendInstruction: async () => {
        sends += 1;
        if (sends === 1) {
          throw Object.assign(new Error("crash before actuation"), {
            code: "SIMULATED_CRASH"
          });
        }
        sent = true;
        return { executed: true };
      }
    }).catch(() => {});

    const result = await reconcileExactOnceOutbound({
      statePath,
      page: { async waitForTimeout() {} },
      messageId: "m3",
      message,
      reconciliationProbes: 2,
      inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
      captureTurn: async () => sent
        ? { turn_id: "u1", text: message }
        : { turn_id: "u0", text: "old" },
      sendInstruction: async () => {
        sends += 1;
        sent = true;
        return { executed: true };
      }
    });

    assert.equal(result.action, "SAFE_RETRY_SENT");
    assert.equal(result.retry_count, 1);
    assert.equal(sends, 2);

    // Already DELIVERED: another reconciliation never sends.
    const again = await reconcileExactOnceOutbound({
      statePath,
      page: { async waitForTimeout() {} },
      messageId: "m3",
      message,
      sendInstruction: async () => {
        sends += 1;
        return { executed: true };
      }
    });
    assert.equal(again.action, "NO_SEND");
    assert.equal(sends, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-006 different new user turn fails closed instead of resending", async () => {
  const { root, statePath } = await makeState();
  const message = "MAGASIN_SINGLE_CONVERSATION_NEXT_V1 id=m4";
  try {
    await prepareExactOnceOutbound(statePath, {
      messageId: "m4",
      message,
      kind: "NEXT",
      baselineUserTurnId: "u0"
    });

    // Force an ENQUEUED state through a failed first send.
    await reconcileExactOnceOutbound({
      statePath,
      page: { async waitForTimeout() {} },
      messageId: "m4",
      message,
      reconciliationProbes: 1,
      inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
      captureTurn: async () => ({ turn_id: "u0", text: "old" }),
      sendInstruction: async () => {
        throw Object.assign(new Error("crash"), { code: "SIMULATED_CRASH" });
      }
    }).catch(() => {});

    let sends = 0;
    await assert.rejects(
      reconcileExactOnceOutbound({
        statePath,
        page: { async waitForTimeout() {} },
        messageId: "m4",
        message,
        reconciliationProbes: 1,
        inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
        captureTurn: async () => ({
          turn_id: "u-other",
          text: "different human/user turn"
        }),
        sendInstruction: async () => {
          sends += 1;
          return { executed: true };
        }
      }),
      (error) => error?.code === "AMBIGUOUS_ENQUEUED_OUTCOME"
    );
    assert.equal(sends, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-006 response completion must reach VERIFIED explicitly", async () => {
  const { root, statePath } = await makeState();
  const message = "MAGASIN_SINGLE_CONVERSATION_NEXT_V1 id=m5";
  try {
    await prepareExactOnceOutbound(statePath, {
      messageId: "m5",
      message,
      kind: "NEXT"
    });
    await reconcileExactOnceOutbound({
      statePath,
      page: { async waitForTimeout() {} },
      messageId: "m5",
      message,
      reconciliationProbes: 1,
      inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
      captureTurn: (() => {
        let sent = false;
        return async (_page, role) => {
          if (role !== "user") return null;
          if (sent) return { turn_id: "u5", text: message };
          return null;
        };
      })(),
      sendInstruction: async () => ({ executed: true })
    }).catch(() => {});

    // Directly construct delivery evidence using a second reconciliation.
    await reconcileExactOnceOutbound({
      statePath,
      page: { async waitForTimeout() {} },
      messageId: "m5",
      message,
      reconciliationProbes: 1,
      inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
      captureTurn: async () => ({ turn_id: "u5", text: message })
    });

    await markExactOnceResponseComplete(statePath, {
      messageId: "m5",
      message
    });
    let durable = await readSingleConversationState(statePath);
    assert.equal(durable.outbound.state, "RESPONSE_COMPLETE");
    assert.equal(durable.outbound.verified_at, null);

    await markExactOnceVerified(statePath, {
      messageId: "m5",
      message
    });
    durable = await readSingleConversationState(statePath);
    assert.equal(durable.outbound.state, "VERIFIED");
    assert.ok(durable.outbound.verified_at);
    assert.equal(durable.source_of_truth.sync_status, "VERIFIED");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
