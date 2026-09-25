import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  LANE_DIRECTIVE_START,
  LANE_DIRECTIVE_END,
  parseLaneDirective,
  buildBrainStartRequest,
  buildLegacyBrainStartRequestV59,
  buildWorkDispatchInstruction,
  buildLaneResultRelay
} from "../src/runtime/three-lane.mjs";
import {
  evaluateBrainVerdictTransition
} from "../src/runtime/brain-planning.mjs";
import {
  LANE_EVENT_TYPES,
  serializeLaneEvent
} from "../src/runtime/lane-events.mjs";
import { projectLaneOperationalStatus } from "../src/runtime/status-projection.mjs";

const RELAY = "a".repeat(32);

function directive(payload) {
  return [
    LANE_DIRECTIVE_START,
    JSON.stringify(payload),
    LANE_DIRECTIVE_END
  ].join("\n");
}

test("A old WORK v1 directive keeps legacy parse shape", () => {
  const parsed = parseLaneDirective(directive({
    action: "WORK",
    task_id: "TASK-1",
    instruction: "Do one thing."
  }));
  assert.deepEqual(Object.keys(parsed), [
    "schema_version","action","task_id","instruction","instruction_digest","digest"
  ]);
  assert.equal(parsed.action, "WORK");
  assert.equal(parsed.task_id, "TASK-1");
});

test("B old IDLE v1 directive keeps legacy parse shape", () => {
  const parsed = parseLaneDirective(directive({ action: "IDLE" }));
  assert.deepEqual(Object.keys(parsed), ["schema_version","action","digest"]);
  assert.equal(parsed.action, "IDLE");
});

test("C valid ACCEPT metadata parses narrowly", () => {
  const parsed = parseLaneDirective(directive({
    action: "WORK",
    task_id: "TASK-2",
    instruction: "Next task.",
    previous_result: {
      task_id: "TASK-1",
      relay_id: RELAY,
      verdict: "ACCEPT",
      reason_code: "ACCEPT_DOD_MET"
    }
  }));
  assert.equal(parsed.previous_result.verdict, "ACCEPT");
  assert.equal(parsed.previous_result.relay_id, RELAY);
});

test("D valid REJECT correction metadata parses narrowly", () => {
  const parsed = parseLaneDirective(directive({
    action: "WORK",
    task_id: "TASK-1-FIX",
    instruction: "Correct the bounded defect.",
    previous_result: {
      task_id: "TASK-1",
      relay_id: RELAY,
      verdict: "REJECT",
      reason_code: "REJECT_CORRECTION_REQUIRED"
    },
    correction_of: { task_id: "TASK-1", relay_id: RELAY }
  }));
  assert.equal(parsed.previous_result.verdict, "REJECT");
  assert.equal(parsed.correction_of.task_id, "TASK-1");
});

test("E malformed known verdict metadata fails closed", () => {
  assert.throws(() => parseLaneDirective(directive({
    action: "IDLE",
    previous_result: { task_id: "TASK-1", relay_id: RELAY, verdict: "MAYBE" }
  })), /verdict/);
});

test("unknown directive fields are not a covert control surface", () => {
  assert.throws(() => parseLaneDirective(directive({
    action: "IDLE",
    hidden_control: true
  })), /unsupported directive field/);
});

test("correction_of without previous_result fails closed", () => {
  assert.throws(() => parseLaneDirective(directive({
    action: "WORK",
    task_id: "TASK-2",
    instruction: "No correlation.",
    correction_of: { task_id: "TASK-1", relay_id: RELAY }
  })), /requires previous_result/);
});

function lane(overrides = {}) {
  return {
    task_id: "TASK-1",
    last_result_relay_id: RELAY,
    last_result_verdict: null,
    ...overrides
  };
}

test("F mismatched previous task_id fails closed", () => {
  assert.throws(() => evaluateBrainVerdictTransition(lane(), {
    action: "IDLE",
    previous_result: { task_id: "OTHER", relay_id: RELAY, verdict: "ACCEPT" }
  }), /task_id/);
});

test("G mismatched relay_id fails closed", () => {
  assert.throws(() => evaluateBrainVerdictTransition(lane(), {
    action: "IDLE",
    previous_result: { task_id: "TASK-1", relay_id: "b".repeat(32), verdict: "ACCEPT" }
  }), /relay_id/);
});

test("H duplicate same verdict is idempotent", () => {
  const stored = {
    task_id: "TASK-1", relay_id: RELAY, verdict: "ACCEPT",
    reason_code: "ACCEPT_DOD_MET", recorded_at: "2026-09-21T03:00:00.000Z"
  };
  const out = evaluateBrainVerdictTransition(lane({ last_result_verdict: stored }), {
    action: "IDLE",
    previous_result: {
      task_id: "TASK-1", relay_id: RELAY, verdict: "ACCEPT",
      reason_code: "ACCEPT_DOD_MET"
    }
  });
  assert.equal(out.state, "IDEMPOTENT");
  assert.equal(out.changed, false);
});

test("I conflicting verdict for same relay fails closed", () => {
  assert.throws(() => evaluateBrainVerdictTransition(lane({
    last_result_verdict: {
      task_id: "TASK-1", relay_id: RELAY, verdict: "ACCEPT",
      reason_code: null, recorded_at: "2026-09-21T03:00:00.000Z"
    }
  }), {
    action: "IDLE",
    previous_result: { task_id: "TASK-1", relay_id: RELAY, verdict: "REJECT" }
  }), /conflicting/);
});

test("J ACCEPT permits dependency-correct next WORK", () => {
  const out = evaluateBrainVerdictTransition(lane(), {
    action: "WORK",
    task_id: "TASK-2",
    instruction: "Bounded next task.",
    previous_result: { task_id: "TASK-1", relay_id: RELAY, verdict: "ACCEPT" }
  });
  assert.equal(out.state, "NEW");
  assert.equal(out.record.verdict, "ACCEPT");
});

test("K ACCEPT plus IDLE is valid", () => {
  const out = evaluateBrainVerdictTransition(lane(), {
    action: "IDLE",
    previous_result: { task_id: "TASK-1", relay_id: RELAY, verdict: "ACCEPT" }
  });
  assert.equal(out.record.verdict, "ACCEPT");
});

test("L REJECT cannot dispatch unrelated next task", () => {
  assert.throws(() => evaluateBrainVerdictTransition(lane(), {
    action: "WORK",
    task_id: "TASK-2",
    instruction: "Unrelated task.",
    previous_result: { task_id: "TASK-1", relay_id: RELAY, verdict: "REJECT" }
  }), /unrelated/);
});

test("M REJECT same-task correction is bounded and valid", () => {
  const out = evaluateBrainVerdictTransition(lane(), {
    action: "WORK",
    task_id: "TASK-1",
    instruction: "Correct only failed evidence.",
    previous_result: { task_id: "TASK-1", relay_id: RELAY, verdict: "REJECT" }
  });
  assert.equal(out.record.verdict, "REJECT");
});

test("M explicit correction_of can use a correction task id", () => {
  const out = evaluateBrainVerdictTransition(lane(), {
    action: "WORK",
    task_id: "TASK-1-FIX",
    instruction: "Bounded correction.",
    previous_result: { task_id: "TASK-1", relay_id: RELAY, verdict: "REJECT" },
    correction_of: { task_id: "TASK-1", relay_id: RELAY }
  });
  assert.equal(out.state, "NEW");
});

test("P legacy Brain without verdict metadata remains valid", () => {
  assert.deepEqual(
    evaluateBrainVerdictTransition(lane(), { action: "WORK", task_id: "TASK-2" }),
    { state: "LEGACY", record: null, changed: false }
  );
});

test("N/O new Work envelope always contains stop guard", () => {
  const text = buildWorkDispatchInstruction({
    taskId: "TASK-2", dispatchId: "c".repeat(32), instruction: "Do bounded work."
  });
  assert.match(text, /WORK_EXECUTION_CONTRACT_V1/);
  assert.match(text, /không tự bắt đầu task tiếp theo/i);
  assert.match(text, /trả result\/evidence rồi DỪNG/i);
});

test("V v59 active dispatch can reconstruct exact legacy envelope", () => {
  const text = buildWorkDispatchInstruction({
    taskId: "TASK-OLD", dispatchId: "d".repeat(32),
    instruction: "Legacy body.", planningContract: false
  });
  assert.equal(text, [
    "MAGASIN_WORK_DISPATCH_V1",
    "task_id=TASK-OLD",
    "dispatch_id=" + "d".repeat(32),
    "",
    "Legacy body."
  ].join("\n"));
});

test("Z Brain prompt contains planning size guidance without watchdog timeout mutation", () => {
  const prompt = buildBrainStartRequest({ laneId: "lane-1", projectName: "P" });
  assert.match(prompt, /<=20 phút/);
  assert.match(prompt, />30 phút/);
  assert.match(prompt, /KHÔNG phải runtime timeout/);
  assert.match(prompt, /PLAN → DISPATCH → VERIFY → ACCEPT\/REJECT → NEXT PLAN/);
});

test("U v59 handshake template remains available for digest compatibility", () => {
  const oldPrompt = buildLegacyBrainStartRequestV59({ laneId: "lane-1", projectName: "P" });
  const nextPrompt = buildBrainStartRequest({ laneId: "lane-1", projectName: "P" });
  assert.notEqual(oldPrompt, nextPrompt);
  assert.match(oldPrompt, /giao đúng một việc tiếp theo/);
  assert.doesNotMatch(oldPrompt, /WORK_EXECUTION_CONTRACT_V1/);
});

test("result relay requests VERIFY and machine verdict correlation", () => {
  const relay = buildLaneResultRelay({
    laneId: "lane-1", projectName: "P", taskId: "TASK-1",
    generation: 1, responseText: "Result"
  });
  assert.match(relay.text, /VERIFY kết quả/);
  assert.match(relay.text, /previous_result=/);
  assert.match(relay.text, /RESULT_RELAY_CONFIRMED chỉ là transport fact/);
  assert.match(relay.text, new RegExp(relay.relay_id));
});

test("R verdict events are metadata-only and allowlisted", () => {
  const event = serializeLaneEvent({
    timestamp: "2026-09-21T03:00:00.000Z",
    lane_id: "lane-1",
    actor: "BRAIN",
    event_type: LANE_EVENT_TYPES.BRAIN_RESULT_ACCEPTED,
    task_id: "TASK-1",
    phase: "ACCEPTED",
    reason_code: "ACCEPT_DOD_MET",
    relay_id: RELAY
  });
  const text = JSON.stringify(event);
  assert.doesNotMatch(text, /https?:|message|cookie|token|screenshot/i);
  assert.equal(event.relay_id, RELAY);
});

test("status projection exposes only safe last verdict summary", () => {
  const out = projectLaneOperationalStatus({}, {
    last_result_verdict: {
      task_id: "TASK-1", relay_id: RELAY, verdict: "ACCEPT",
      reason_code: "ACCEPT_DOD_MET", recorded_at: "2026-09-21T03:00:00.000Z"
    }
  }, "READY");
  assert.equal(out.last_result_verdict.verdict, "ACCEPT");
  assert.equal("instruction" in out.last_result_verdict, false);
});

test("CLI contains dual handshake migration and active-latch legacy envelope gate", async () => {
  const source = await fs.readFile(new URL("../src/runtime/three-lane-cli.mjs", import.meta.url), "utf8");
  assert.match(source, /buildLegacyBrainStartRequestV59/);
  assert.match(source, /expectedStartDigests/);
  assert.match(source, /planning_contract_version/);
  assert.match(source, /existingDispatchLatch\?\.directive_digest/);
  assert.match(source, /coreDispatchDigest/);
  assert.match(source, /LANE_WORK_LEGACY_SEND_NOT_CONFIRMED_RETRY_SAME_IDENTITY/);
  assert.match(source, /applyBrainVerdictDirective/);
});


test("processed Brain directive short-circuits before previous_result revalidation", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  const duplicateGuard = source.indexOf(
    "directive.digest === registryLane.last_brain_directive_digest"
  );
  const verdictApply = source.indexOf(
    "await applyBrainVerdictDirective({",
    duplicateGuard
  );

  assert.ok(duplicateGuard >= 0);
  assert.ok(verdictApply > duplicateGuard);
  assert.match(source, /LANE_BRAIN_STALE_DIRECTIVE_SKIPPED/);
  assert.match(
    source,
    /evaluateBrainVerdictTransition\(registryLane, candidate\)/
  );
});
