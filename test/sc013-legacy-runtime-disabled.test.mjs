import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("SC-013 production wrapper cannot select legacy Planner Executor runtime", async () => {
  const source = await fs.readFile(
    new URL("../windows/run-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /Planner\/Executor is superseded and must never be selected by[\s\S]*production runtime resolution/
  );
  assert.doesNotMatch(
    source,
    /if \(\[string\]\$plannerExecutorState\.mode -eq 'PLANNER_EXECUTOR_V1'\) \{\s*return 'PLANNER_EXECUTOR_V1'/
  );
  assert.match(
    source,
    /LEGACY_PLANNER_EXECUTOR_SELECTION_IGNORED=True/
  );
  assert.match(
    source,
    /if \(\$runtimeMode -ne 'SINGLE_CONVERSATION_V1'\)/
  );
});
