import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  buildBrainStartRequest,
  evaluateBrainDirectiveAdoptionEvidence,
  sha256
} from "../src/runtime/three-lane.mjs";

const brainUrl = "https://chatgpt.com/c/brain";
const brainDigest = sha256(brainUrl);
const revision = 7;
const handshake = buildBrainStartRequest({
  laneId: "lane-1",
  projectName: "Supervisor"
});
const handshakeDigest = sha256(handshake);
const directiveText =
  '<<<MAGASIN_LANE_DIRECTIVE_V1>>>\n' +
  '{"action":"WORK","task_id":"SCHED-06","instruction":"Run bounded SCHED-06"}\n' +
  '<<<END_MAGASIN_LANE_DIRECTIVE_V1>>>';
const directiveTurn = {
  role: "assistant",
  text: directiveText,
  turn: 8,
  digest: sha256(directiveText)
};

function evidence(overrides = {}) {
  return evaluateBrainDirectiveAdoptionEvidence({
    turns: [directiveTurn],
    expectedHandshakeDigests: [handshakeDigest],
    currentTargetDigest: brainDigest,
    configuredTargetDigest: brainDigest,
    configuredRevision: revision,
    appliedRevision: revision,
    brainRequestInflight: {
      digest: handshakeDigest,
      brain_target_digest: brainDigest,
      brain_url_revision: revision
    },
    adoptedRecord: null,
    activeExactOnce: false,
    ...overrides
  });
}

test("P1 A valid existing WORK directive is adoptable", () => {
  const result = evidence({ brainRequestInflight: null });
  assert.equal(result.adopt, true);
  assert.equal(result.directive.task_id, "SCHED-06");
  assert.equal(result.candidate_turn, 8);
});

test("P1 B stale same-target Brain handshake is superseded by valid directive evidence", () => {
  const result = evidence();
  assert.equal(result.adopt, true);
  assert.equal(result.reason_code, "STALE_HANDSHAKE_SUPERSEDED_BY_VALID_DIRECTIVE");
});

test("P1 C Brain target digest mismatch fails closed", () => {
  const result = evidence({ configuredTargetDigest: sha256("https://chatgpt.com/c/other") });
  assert.equal(result.adopt, false);
  assert.equal(result.reason_code, "BRAIN_TARGET_DIGEST_MISMATCH");
});

test("P1 D Brain revision mismatch fails closed", () => {
  const result = evidence({ configuredRevision: revision + 1 });
  assert.equal(result.adopt, false);
  assert.equal(result.reason_code, "BRAIN_TARGET_REVISION_MISMATCH");

  const latchMismatch = evidence({
    brainRequestInflight: {
      digest: handshakeDigest,
      brain_target_digest: brainDigest,
      brain_url_revision: revision - 1
    }
  });
  assert.equal(latchMismatch.adopt, false);
  assert.equal(latchMismatch.reason_code, "BRAIN_LATCH_REVISION_MISMATCH");
});

test("P1 E newer non-Robot user or assistant activity invalidates adoption", () => {
  const newerOwner = evidence({
    turns: [
      directiveTurn,
      { role: "user", text: "Owner changed direction", turn: 9, digest: sha256("owner") }
    ]
  });
  assert.equal(newerOwner.adopt, false);
  assert.equal(newerOwner.reason_code, "NEWER_NON_ROBOT_ACTIVITY");

  const newerAssistant = evidence({
    turns: [
      directiveTurn,
      { role: "assistant", text: "unrelated response", turn: 10, digest: sha256("assistant") }
    ]
  });
  assert.equal(newerAssistant.adopt, false);
  assert.equal(newerAssistant.reason_code, "NEWER_NON_ROBOT_ACTIVITY");
});

test("P1 exact-once unresolved state blocks adoption without mutation authority", () => {
  const result = evidence({ activeExactOnce: true });
  assert.equal(result.adopt, false);
  assert.equal(result.reason_code, "ACTIVE_EXACT_ONCE_TRANSACTION");
});

test("P1 F duplicate Robot handshake after directive remains recoverable", () => {
  const result = evidence({
    turns: [
      directiveTurn,
      { role: "user", text: handshake, turn: 9, digest: handshakeDigest }
    ]
  });
  assert.equal(result.adopt, true);
  assert.equal(result.later_robot_handshake_count, 1);
});

test("P1 G malformed directive and prose are never inferred", () => {
  const malformed = evidence({
    turns: [{
      role: "assistant",
      text: '<<<MAGASIN_LANE_DIRECTIVE_V1>>>\n{"action":"WORK"}\n<<<END_MAGASIN_LANE_DIRECTIVE_V1>>>',
      turn: 8,
      digest: sha256("malformed")
    }]
  });
  assert.equal(malformed.adopt, false);
  assert.equal(malformed.reason_code, "NO_VALID_DIRECTIVE");

  const prose = evidence({
    turns: [{
      role: "assistant",
      text: "Please execute SCHED-06.",
      turn: 8,
      digest: sha256("prose")
    }]
  });
  assert.equal(prose.adopt, false);
  assert.equal(prose.reason_code, "NO_VALID_DIRECTIVE");
});

test("P1 H restart/idempotence accepts only the same persisted adopted identity", () => {
  const first = evidence();
  const adoptedRecord = {
    directive_digest: first.directive.digest,
    task_id: first.directive.task_id,
    brain_target_digest: brainDigest,
    brain_url_revision: revision
  };
  const restarted = evidence({ adoptedRecord });
  assert.equal(restarted.adopt, true);
  assert.equal(restarted.reason_code, "DIRECTIVE_ALREADY_ADOPTED_IDEMPOTENT");
  assert.equal(restarted.directive.task_id, adoptedRecord.task_id);

  const conflict = evidence({
    adoptedRecord: {
      ...adoptedRecord,
      directive_digest: sha256("different-directive")
    }
  });
  assert.equal(conflict.adopt, false);
  assert.equal(conflict.reason_code, "ADOPTED_DIRECTIVE_IDENTITY_CONFLICT");
});

test("P1 runtime persists sanitized adoption identity and suppresses duplicate handshake path", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /brain_target_digest: sha256/);
  assert.match(source, /brain_url_revision: Number\(registryLane\.applied_brain_url_revision/);
  assert.match(source, /brain_directive_adopted = \{/);
  assert.match(source, /assistant_turn:/);
  assert.match(source, /later_robot_handshake_count:/);
  assert.match(source, /LANE_BRAIN_STALE_HANDSHAKE_SUPERSEDED/);
  assert.match(source, /LANE_BRAIN_DIRECTIVE_ADOPTED/);
  assert.match(source, /recoverPersistedAdoptedBrainDirective/);
  assert.match(source, /if \(registryLane\.brain_request_sent\) return null/);
  assert.match(source, /activeExactOnce: Boolean\(/);
});
