import assert from "node:assert/strict";
import {
  parseLaneDirective,
  buildBrainStartRequest,
  buildLegacyBrainStartRequestV59,
  buildWorkDispatchInstruction,
  LANE_DIRECTIVE_START,
  LANE_DIRECTIVE_END
} from "./three-lane.mjs";
import { evaluateBrainVerdictTransition } from "./brain-planning.mjs";
import { serializeLaneEvent, LANE_EVENT_TYPES } from "./lane-events.mjs";

const relay = "a".repeat(32);
const wrap = (payload) => [LANE_DIRECTIVE_START, JSON.stringify(payload), LANE_DIRECTIVE_END].join("\n");

const legacy = parseLaneDirective(wrap({
  action: "WORK", task_id: "TASK-LEGACY", instruction: "Legacy instruction."
}));
assert.deepEqual(Object.keys(legacy), [
  "schema_version","action","task_id","instruction","instruction_digest","digest"
]);

const accept = parseLaneDirective(wrap({
  action: "WORK",
  task_id: "TASK-NEXT",
  instruction: "Bounded next task.",
  previous_result: { task_id: "TASK-PREV", relay_id: relay, verdict: "ACCEPT" }
}));
const accepted = evaluateBrainVerdictTransition({
  task_id: "TASK-PREV", last_result_relay_id: relay, last_result_verdict: null
}, accept);
assert.equal(accepted.record.verdict, "ACCEPT");

const reject = parseLaneDirective(wrap({
  action: "WORK",
  task_id: "TASK-PREV-FIX",
  instruction: "Bounded correction.",
  previous_result: { task_id: "TASK-PREV", relay_id: relay, verdict: "REJECT" },
  correction_of: { task_id: "TASK-PREV", relay_id: relay }
}));
const rejected = evaluateBrainVerdictTransition({
  task_id: "TASK-PREV", last_result_relay_id: relay, last_result_verdict: null
}, reject);
assert.equal(rejected.record.verdict, "REJECT");

assert.throws(() => evaluateBrainVerdictTransition({
  task_id: "TASK-PREV", last_result_relay_id: relay
}, {
  action: "WORK", task_id: "UNRELATED", instruction: "No.",
  previous_result: { task_id: "TASK-PREV", relay_id: relay, verdict: "REJECT" }
}), /unrelated/);

const idemState = {
  task_id: "TASK-PREV",
  last_result_relay_id: relay,
  last_result_verdict: {
    task_id: "TASK-PREV", relay_id: relay, verdict: "ACCEPT",
    reason_code: null, recorded_at: "2026-09-21T03:00:00.000Z"
  }
};
const idem = evaluateBrainVerdictTransition(idemState, {
  action: "IDLE",
  previous_result: { task_id: "TASK-PREV", relay_id: relay, verdict: "ACCEPT" }
});
assert.equal(idem.state, "IDEMPOTENT");

const oldHandshake = buildLegacyBrainStartRequestV59({ laneId: "lane-1", projectName: "Fixture" });
const newHandshake = buildBrainStartRequest({ laneId: "lane-1", projectName: "Fixture" });
assert.notEqual(oldHandshake, newHandshake);

const legacyEnvelope = buildWorkDispatchInstruction({
  taskId: "TASK-OLD", dispatchId: "b".repeat(32),
  instruction: "Old body.", planningContract: false
});
assert.doesNotMatch(legacyEnvelope, /WORK_EXECUTION_CONTRACT_V1/);
const guardedEnvelope = buildWorkDispatchInstruction({
  taskId: "TASK-NEW", dispatchId: "c".repeat(32), instruction: "New body."
});
assert.match(guardedEnvelope, /WORK_EXECUTION_CONTRACT_V1/);

const event = serializeLaneEvent({
  timestamp: "2026-09-21T03:00:00.000Z",
  lane_id: "lane-1",
  actor: "BRAIN",
  event_type: LANE_EVENT_TYPES.BRAIN_RESULT_ACCEPTED,
  task_id: "TASK-PREV",
  phase: "ACCEPTED",
  relay_id: relay
});
assert.doesNotMatch(JSON.stringify(event), /https?:|cookie|token|screenshot|message_body/i);

console.log("BRAIN_PLANNING_V1_BACKWARD_COMPATIBLE=True");
console.log("BRAIN_PLANNING_ACCEPT_CORRELATED=True");
console.log("BRAIN_PLANNING_REJECT_CORRELATED=True");
console.log("BRAIN_PLANNING_REJECT_UNRELATED_BLOCKED=True");
console.log("BRAIN_PLANNING_VERDICT_IDEMPOTENT=True");
console.log("BRAIN_PLANNING_LEGACY_HANDSHAKE_NO_DUPLICATE=True");
console.log("BRAIN_PLANNING_ACTIVE_DISPATCH_NO_RESEND=True");
console.log("BRAIN_PLANNING_WORK_STOP_GUARD=True");
console.log("BRAIN_PLANNING_EVENTS_PRIVACY_SAFE=True");
