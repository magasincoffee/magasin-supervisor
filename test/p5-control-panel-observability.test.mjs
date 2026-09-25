import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(rel) {
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

test("P5 Control Panel exposes every required process and lane observability field", async () => {
  const panel = await read("../windows/control-panel.ps1");

  for (const label of [
    "WRAPPER ",
    "THREE-LANE ",
    "CHROME ",
    "CDP ",
    "STATUS AGE ",
    "CHATGPT PAGE COUNT: ",
    "BRAIN HEALTH",
    "BRAIN DIRECTIVE: ",
    "ACTIVE TASK: ",
    "WORK TARGET MODE: ",
    "WORK TARGET HEALTH",
    "WORK RESET requested r",
    "WORK GENERATION: "
  ]) {
    assert.ok(panel.includes(label), `missing P5 label: ${label}`);
  }
});

test("P5 observability probe exposes sanitized per-lane fields only", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("if ($ObservabilityProbe)");
  const end = panel.indexOf("function Write-JsonAtomic", start);
  const probe = panel.slice(start, end);

  for (const field of [
    "wrapper_alive","three_lane_alive","chrome_alive","cdp_healthy",
    "status_age_seconds","chatgpt_page_count","brain_health",
    "brain_directive","brain_directive_reason_code","active_task",
    "work_target_mode","work_target_health","work_reset_requested_revision",
    "work_reset_applied_revision","work_generation"
  ]) {
    assert.match(probe, new RegExp(field));
  }

  for (const forbidden of [
    "target_digest","directive_digest","instruction_digest",
    "brain_url =","work_url =","message_body","cookie","token","screenshot"
  ]) {
    assert.doesNotMatch(probe, new RegExp(forbidden, "i"));
  }
});

test("P5 invalid Brain output maps to allowlisted reason codes and never becomes a guessed task", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const start = runtime.indexOf("function brainDirectiveInvalidReason");
  const end = runtime.indexOf("function laneStatus", start);
  const classifier = runtime.slice(start, end);

  for (const code of [
    "MISSING_DIRECTIVE_BLOCK",
    "INVALID_DIRECTIVE_JSON",
    "UNSUPPORTED_DIRECTIVE_ACTION",
    "INVALID_DIRECTIVE_SCHEMA"
  ]) {
    assert.match(classifier, new RegExp(code));
  }

  const parseStart = runtime.indexOf("directive = parseLaneDirective(captured.text);");
  const parseEnd = runtime.indexOf("await applyBrainVerdictDirective", parseStart);
  assert.ok(parseStart >= 0 && parseEnd > parseStart);
  const parseBlock = runtime.slice(parseStart, parseEnd);
  assert.match(parseBlock, /brain_directive_state: "INVALID"/);
  assert.match(parseBlock, /brain_directive_reason_code: brainDirectiveInvalidReason\(error\)/);
  assert.doesNotMatch(parseBlock, /task_id\s*=|instruction_digest\s*=|dispatchWork\(/);
});

test("P5 UI derives reset revisions and generation from status/config/registry truth", async () => {
  const panel = await read("../windows/control-panel.ps1");
  assert.match(panel, /work_reset_requested_revision/);
  assert.match(panel, /work_state_reset_revision/);
  assert.match(panel, /work_reset_applied_revision/);
  assert.match(panel, /applied_work_state_reset_revision/);
  assert.match(panel, /work_generation/);
  assert.match(panel, /work_mode/);
});
