import test from "node:test";
import assert from "node:assert/strict";

import {
  BRAIN_DIRECTIVE_START,
  BRAIN_DIRECTIVE_END,
  assertRolloverAuthorized,
  buildWorkerResultEnvelope,
  canCreateWorker,
  newRegistry,
  parseBrainDirective,
  sanitizeRegistry
} from "../src/runtime/orchestration.mjs";

test("Brain directive supplies dynamic Worker instructions", () => {
  const text = [
    "analysis",
    BRAIN_DIRECTIVE_START,
    JSON.stringify({
      actions: [
        {
          type: "DISPATCH",
          worker_id: "worker-1",
          task_id: "WORK-049/A",
          instruction: "Inspect recovery guards and return concrete findings."
        },
        {
          type: "DISPATCH",
          worker_id: "worker-2",
          task_id: "WORK-049/B",
          instruction: "Verify Windows runtime selection independently."
        }
      ]
    }),
    BRAIN_DIRECTIVE_END
  ].join("\n");

  const parsed = parseBrainDirective(text, { maxWorkers: 3 });
  assert.equal(parsed.actions.length, 2);
  assert.notEqual(parsed.actions[0].instruction, parsed.actions[1].instruction);
  assert.match(parsed.actions[0].instruction_digest, /^[a-f0-9]{64}$/);
});

test("malformed or unsupported Brain directives fail closed", () => {
  assert.throws(() => parseBrainDirective("no block"), /missing/);
  assert.throws(
    () => parseBrainDirective(
      BRAIN_DIRECTIVE_START +
      '{"actions":[{"type":"NEW_CHAT"}]}' +
      BRAIN_DIRECTIVE_END
    ),
    /unsupported/
  );
});

test("new Worker creation requires validated Brain directive and capacity", () => {
  const registry = newRegistry();
  assert.equal(canCreateWorker({
    registry,
    workerId: "worker-1",
    maxWorkers: 2,
    brainDirectiveValidated: false
  }), false);
  assert.equal(canCreateWorker({
    registry,
    workerId: "worker-1",
    maxWorkers: 2,
    brainDirectiveValidated: true
  }), true);

  registry.workers["worker-1"] = { worker_id: "worker-1" };
  registry.workers["worker-2"] = { worker_id: "worker-2" };
  assert.equal(canCreateWorker({
    registry,
    workerId: "worker-3",
    maxWorkers: 2,
    brainDirectiveValidated: true
  }), false);
});

test("rollover requires positive conversationFull evidence", () => {
  assert.throws(
    () => assertRolloverAuthorized({ conversationFull: false }),
    /rollover denied/
  );
  assert.equal(assertRolloverAuthorized({ conversationFull: true }), true);
});

test("Worker result envelope includes full response once with deterministic relay id", () => {
  const body = "line one\nline two\nline three";
  const first = buildWorkerResultEnvelope({
    workerId: "worker-1",
    taskId: "WORK-049/A",
    generation: 2,
    turn: 17,
    responseText: body
  });
  const second = buildWorkerResultEnvelope({
    workerId: "worker-1",
    taskId: "WORK-049/A",
    generation: 2,
    turn: 17,
    responseText: body
  });

  assert.equal(first.relay_id, second.relay_id);
  assert.equal(first.text.split(body).length - 1, 1);
  assert.equal(first.char_count, body.length);
});

test("registry sanitizer never persists instruction or response bodies", () => {
  const safe = sanitizeRegistry({
    brain: { target: { origin: "https://chatgpt.com", pathname: "/c/brain" } },
    workers: {
      "worker-1": {
        worker_id: "worker-1",
        task_id: "WORK-049/A",
        instruction: "SECRET BODY",
        responseText: "FULL PRIVATE RESPONSE",
        instruction_digest: "abc",
        last_result_digest: "def"
      }
    }
  });

  const encoded = JSON.stringify(safe);
  assert.doesNotMatch(encoded, /SECRET BODY/);
  assert.doesNotMatch(encoded, /FULL PRIVATE RESPONSE/);
  assert.equal(safe.workers["worker-1"].instruction_digest, "abc");
});
