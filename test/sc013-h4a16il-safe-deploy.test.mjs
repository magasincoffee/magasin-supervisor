import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const workflow = new URL("../.github/workflows/sc013-h4a16il-safe-deploy.yml", import.meta.url);
const script = new URL("../.github/scripts/sc013-h4a16il-safe-stage-deploy.ps1", import.meta.url);

test("H4 staging workflow uses exact machine and explicit trigger", async () => {
  const w = await fs.readFile(workflow,"utf8");
  assert.ok(w.includes("DESKTOP-H4A16IL"));
  assert.ok(w.includes("workflow_dispatch:"));
  assert.ok(w.includes("sc013-h4a16il-stage-request.json"));
  assert.ok(w.includes("TARGET_MUTATION_SKIPPED=True"));
  assert.ok(w.includes("PUSH_IS_STAGE_ONLY"));
  assert.ok(w.includes("cancel-in-progress: false"));
});
test("H4 stage checks canonical main and keeps previous source backed up", async () => {
  const s = await fs.readFile(script,"utf8");
  for (const marker of [
    "MAIN_SHA_CHANGED_REDISPATCH_REQUIRED",
    "LOCAL_SOURCE_DRIFT_REQUIRES_REVIEW",
    "FORMAT_ONLY_MODULES=",
    "NormalizeLineEndings",
    "STAGE_NO_PRODUCTION_MUTATION=True",
    "STAGE_COPY_HASH_MISMATCH",
    "C:\\Users\\admin\\AppData\\Local\\MAGASIN",
    "D:\\MAGASIN_ROBOTS\\deploy\\sc013-h4a16il"
  ]) assert.ok(s.includes(marker),marker);
});
test("H4 apply requires owner and transaction safety gates", async () => {
  const s = await fs.readFile(script,"utf8");
  for (const marker of [
    "APPLY_EXPLICIT_DISPATCH_REQUIRED",
    "OWNER_STOP_LATCH_ACTIVE",
    "OWNER_DISABLE_LATCH_ACTIVE",
    "WRAPPER_MUST_BE_STOPPED_FOR_DEPLOY",
    "AMBIGUOUS_OUTBOUND_MUST_BE_RECONCILED_FIRST",
    "RESOURCE_GATES_NOT_GREEN",
    "FORMAT_ONLY_SOURCE_CHANGED_AFTER_STAGE",
    "ROLLBACK_VERIFIED=",
    "NO_SUPERVISOR_START=True",
    "NO_CHROME_RESTART=True"
  ]) assert.ok(s.includes(marker),marker);
});
