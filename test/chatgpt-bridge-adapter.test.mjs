import test from "node:test";
import assert from "node:assert/strict";

import {
  CHATGPT_BRIDGE_DEFAULT_BASE_URL,
  CHATGPT_BRIDGE_PINNED_UPSTREAM_COMMIT,
  CHATGPT_BRIDGE_UPSTREAM_REPOSITORY,
  ChatGptBridgeAdapter,
  ChatGptBridgeError,
  bridgeResponseBaseline,
  normalizeBridgeBaseUrl
} from "../src/runtime/chatgpt-bridge-adapter.mjs";

function jsonResponse(payload, {
  status = 200,
  ok = status >= 200 && status < 300
} = {}) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function snapshot({
  count = 0,
  generating = false,
  assistant = "",
  recent = []
} = {}) {
  return {
    site: "chatgpt",
    url: "https://chatgpt.com/c/test",
    title: "Test",
    hasEditor: true,
    editorText: "",
    assistantCount: count,
    isGenerating: generating,
    recentTurns: recent,
    lastAssistant: assistant
  };
}

test("Bridge adapter defaults to the local pinned-baseline endpoint", () => {
  const adapter = new ChatGptBridgeAdapter({
    fetchImpl: async () => jsonResponse({})
  });
  assert.equal(adapter.baseUrl, CHATGPT_BRIDGE_DEFAULT_BASE_URL);
  assert.equal(CHATGPT_BRIDGE_UPSTREAM_REPOSITORY, "https://github.com/OLmatter/chatgpt-bridge");
  assert.equal(
    CHATGPT_BRIDGE_PINNED_UPSTREAM_COMMIT,
    "848efb9e85f52f251c82ab099747833c0693c072"
  );
});

test("Bridge base URL fails closed for non-local or path-prefixed endpoints", () => {
  assert.throws(
    () => normalizeBridgeBaseUrl("https://bridge.example.test"),
    (error) => error instanceof ChatGptBridgeError && error.code === "NON_LOCAL_BRIDGE_URL"
  );
  assert.throws(
    () => normalizeBridgeBaseUrl("http://127.0.0.1:5000/api"),
    (error) => error instanceof ChatGptBridgeError && error.code === "INVALID_BASE_URL"
  );
  assert.equal(normalizeBridgeBaseUrl("http://localhost:5000/"), "http://localhost:5000");
});

test("listPages and getState normalize exact page identity without role semantics", async () => {
  const adapter = new ChatGptBridgeAdapter({
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, "/pages");
      return jsonResponse({
        pages: [
          {
            page_id: "planner_1234",
            title: "Planner",
            url: "https://chatgpt.com/c/planner",
            alive: true,
            is_generating: false,
            assistant_count: 4,
            last_msg: "ready",
            last_poll_ago: 0.2
          },
          {
            page_id: "executor_5678",
            title: "Executor",
            url: "https://chatgpt.com/c/executor",
            alive: true,
            is_generating: true,
            assistant_count: 8,
            last_msg: "working",
            last_poll_ago: 0.1
          }
        ],
        total: 2
      });
    }
  });

  const pages = await adapter.listPages();
  assert.equal(pages.length, 2);
  assert.equal(pages[0].page_id, "planner_1234");
  assert.equal(pages[1].is_generating, true);

  const executor = await adapter.getState("executor_5678");
  assert.equal(executor.title, "Executor");

  await assert.rejects(
    () => adapter.getState("missing"),
    (error) => error instanceof ChatGptBridgeError && error.code === "PAGE_NOT_FOUND"
  );
});

test("getSnapshot normalizes upstream camelCase fields", async () => {
  const adapter = new ChatGptBridgeAdapter({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/snapshot");
      assert.equal(parsed.searchParams.get("page_id"), "planner_1234");
      return jsonResponse(snapshot({
        count: 3,
        assistant: "latest",
        recent: [
          { role: "user", text: "hello" },
          { role: "assistant", text: "latest" }
        ]
      }));
    }
  });

  const value = await adapter.getSnapshot("planner_1234");
  assert.equal(value.assistant_count, 3);
  assert.equal(value.last_assistant, "latest");
  assert.equal(value.recent_turns.length, 2);
  assert.equal(value.has_editor, true);
});

test("sendAsync targets /send_async and never upstream blocking /send", async () => {
  const calls = [];
  const adapter = new ChatGptBridgeAdapter({
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      calls.push({ pathname: parsed.pathname, options });
      return jsonResponse({ ok: true, cmd_id: "cmd123" });
    }
  });

  const queued = await adapter.sendAsync("planner_1234", "hello");
  assert.deepEqual(queued, {
    ok: true,
    page_id: "planner_1234",
    cmd_id: "cmd123"
  });
  assert.deepEqual(calls.map((call) => call.pathname), ["/send_async"]);
  assert.equal(JSON.parse(calls[0].options.body).page_id, "planner_1234");
});

test("send establishes a baseline, ignores stale snapshots, and completes only on new idle response", async () => {
  const calls = [];
  const snapshots = [
    snapshot({ count: 7, assistant: "old response" }),
    snapshot({ count: 7, assistant: "old response" }),
    snapshot({ count: 8, generating: true, assistant: "new partial" }),
    snapshot({ count: 8, generating: false, assistant: "new final" })
  ];
  let snapshotIndex = 0;
  let now = 0;

  const adapter = new ChatGptBridgeAdapter({
    responseTimeoutMs: 10_000,
    pollIntervalMs: 10,
    nowImpl: () => now,
    sleepImpl: async (ms) => { now += ms; },
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      calls.push(parsed.pathname);
      if (parsed.pathname === "/snapshot") {
        const value = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
        snapshotIndex += 1;
        return jsonResponse(value);
      }
      if (parsed.pathname === "/send_async") {
        assert.equal(options.method, "POST");
        return jsonResponse({ ok: true, cmd_id: "cmd-new" });
      }
      throw new Error("unexpected path " + parsed.pathname);
    }
  });

  const result = await adapter.send("planner_1234", "next");
  assert.equal(result.cmd_id, "cmd-new");
  assert.equal(result.snapshot.last_assistant, "new final");
  assert.equal(result.evidence.response_changed, true);
  assert.equal(result.evidence.count_advanced, true);
  assert.deepEqual(calls, [
    "/snapshot",
    "/send_async",
    "/snapshot",
    "/snapshot",
    "/snapshot"
  ]);
  assert.equal(calls.includes("/send"), false);
});

test("waitResponse can use digest change when upstream count remains stable", async () => {
  let now = 0;
  const currentSnapshots = [
    snapshot({ count: 2, generating: true, assistant: "replacement partial" }),
    snapshot({ count: 2, generating: false, assistant: "replacement final" })
  ];
  let index = 0;

  const baseline = {
    page_id: "planner_1234",
    ...bridgeResponseBaseline({
    site: "chatgpt",
    url: "https://chatgpt.com/c/test",
    title: "Test",
    has_editor: true,
    editor_text: "",
    assistant_count: 2,
    is_generating: false,
    recent_turns: [{ role: "assistant", text: "old" }],
    last_assistant: "old"
    })
  };

  const adapter = new ChatGptBridgeAdapter({
    nowImpl: () => now,
    sleepImpl: async (ms) => { now += ms; },
    fetchImpl: async () => {
      const value = currentSnapshots[Math.min(index, currentSnapshots.length - 1)];
      index += 1;
      return jsonResponse(value);
    }
  });

  const result = await adapter.waitResponse("planner_1234", baseline, {
    timeoutMs: 1000,
    pollIntervalMs: 10
  });
  assert.equal(result.evidence.count_advanced, false);
  assert.equal(result.evidence.digest_changed, true);
  assert.equal(result.snapshot.last_assistant, "replacement final");
});

test("waitResponse rejects an already-generating baseline as ambiguous", async () => {
  const adapter = new ChatGptBridgeAdapter({
    fetchImpl: async () => jsonResponse(snapshot())
  });

  await assert.rejects(
    () => adapter.waitResponse("planner_1234", {
      page_id: "planner_1234",
      assistant_count: 1,
      assistant_digest: "a".repeat(64),
      is_generating: true
    }),
    (error) => error instanceof ChatGptBridgeError && error.code === "AMBIGUOUS_BASELINE"
  );
});


test("waitResponse rejects a baseline captured from a different page_id", async () => {
  const adapter = new ChatGptBridgeAdapter({
    fetchImpl: async () => jsonResponse(snapshot())
  });

  await assert.rejects(
    () => adapter.waitResponse("planner_1234", {
      page_id: "executor_5678",
      assistant_count: 1,
      assistant_digest: "a".repeat(64),
      is_generating: false
    }),
    (error) => error instanceof ChatGptBridgeError && error.code === "BASELINE_PAGE_MISMATCH"
  );
});

test("send refuses to enqueue while target is already generating", async () => {
  const calls = [];
  const adapter = new ChatGptBridgeAdapter({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed.pathname);
      return jsonResponse(snapshot({
        count: 1,
        generating: true,
        assistant: "still generating"
      }));
    }
  });

  await assert.rejects(
    () => adapter.send("planner_1234", "do not duplicate"),
    (error) => error instanceof ChatGptBridgeError && error.code === "PAGE_BUSY"
  );
  assert.deepEqual(calls, ["/snapshot"]);
});

test("waitResponse times out rather than accepting an unchanged stale snapshot", async () => {
  let now = 0;
  const stale = snapshot({ count: 1, assistant: "same" });

  const adapter = new ChatGptBridgeAdapter({
    nowImpl: () => now,
    sleepImpl: async (ms) => { now += ms; },
    fetchImpl: async () => jsonResponse(stale)
  });

  const baseline = {
    page_id: "planner_1234",
    ...bridgeResponseBaseline({
    site: "chatgpt",
    url: "https://chatgpt.com/c/test",
    title: "Test",
    has_editor: true,
    editor_text: "",
    assistant_count: 1,
    is_generating: false,
    recent_turns: [{ role: "assistant", text: "same" }],
    last_assistant: "same"
    })
  };

  await assert.rejects(
    () => adapter.waitResponse("planner_1234", baseline, {
      timeoutMs: 20,
      pollIntervalMs: 10
    }),
    (error) => error instanceof ChatGptBridgeError && error.code === "RESPONSE_TIMEOUT"
  );
});

test("HTTP and malformed responses fail closed with bounded adapter errors", async () => {
  const httpAdapter = new ChatGptBridgeAdapter({
    fetchImpl: async () => jsonResponse(
      { detail: "no page" },
      { status: 500, ok: false }
    )
  });

  await assert.rejects(
    () => httpAdapter.status(),
    (error) => error instanceof ChatGptBridgeError && error.code === "BRIDGE_HTTP_ERROR"
  );

  const malformedAdapter = new ChatGptBridgeAdapter({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() { return "not-json"; }
    })
  });

  await assert.rejects(
    () => malformedAdapter.status(),
    (error) => error instanceof ChatGptBridgeError && error.code === "MALFORMED_BRIDGE_RESPONSE"
  );
});
