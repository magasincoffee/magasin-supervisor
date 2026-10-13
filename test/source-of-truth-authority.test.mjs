import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalPath = "SOURCE_OF_TRUTH.md";
const read = (relativePath) =>
  fs.readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/^\uFEFF/, "");

function walkTextFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!/\.(?:md|json|ya?ml|txt)$/i.test(entry.name)) continue;
      out.push(path.relative(root, full).replaceAll("\\", "/"));
    }
  };
  visit(root);
  return out.sort();
}

function declaresCanonicalProjectSource(text) {
  const sourceMention = /source[ _-]?of[ _-]?truth/i.test(text);
  if (!sourceMention) return false;

  return [
    /Status:\s*\*\*CANONICAL\b/i,
    /"status"\s*:\s*"CANONICAL(?:_|\b)/i,
    /\bThis (?:file|document) is (?:the )?(?:only )?canonical Source of Truth\b/i,
    /\bThis document is the forward architecture authority\b/i,
    /\bThis (?:file|document) is (?:the )?sole project authority\b/i,
  ].some((pattern) => pattern.test(text));
}

test("SOURCE_OF_TRUTH.md is the sole forward project authority", () => {
  const canonical = read(canonicalPath);

  assert.match(canonical, /Status:\s*\*\*CANONICAL \/ SOLE PROJECT AUTHORITY\*\*/);
  assert.match(canonical, /Architecture generation:\s*\*\*SINGLE_CONVERSATION_V1\*\*/);
  assert.match(
    canonical,
    /This file is the \*\*only canonical Source of Truth for the MAGASIN Supervisor project\*\*/
  );

  const declarations = [];
  for (const relativePath of walkTextFiles(repoRoot)) {
    if (relativePath === canonicalPath || relativePath === "README.md") continue;
    const text = read(relativePath);
    if (declaresCanonicalProjectSource(text)) declarations.push(relativePath);
  }

  assert.deepEqual(
    declarations,
    [],
    "competing canonical Source of Truth declarations: " + declarations.join(", ")
  );
});

test("former Planner/Executor authorities remain explicit tombstones", () => {
  const legacyMd = read("docs/SUPERVISOR_PLANNER_EXECUTOR_V1_SOURCE_OF_TRUTH.md");
  const legacyJson = JSON.parse(
    read("docs/SUPERVISOR_PLANNER_EXECUTOR_V1_SOURCE_OF_TRUTH.json")
  );

  assert.match(legacyMd, /^# SUPERSEDED — Planner \/ Executor V1/m);
  assert.match(legacyMd, /Status:\s*\*\*HISTORICAL \/ NON-AUTHORITATIVE\*\*/);
  assert.ok(legacyMd.includes("`/SOURCE_OF_TRUTH.md`"));
  assert.doesNotMatch(legacyMd, /Status:\s*\*\*CANONICAL\b/i);

  assert.equal(legacyJson.status, "HISTORICAL_NON_AUTHORITATIVE");
  assert.equal(legacyJson.canonical_source, "/SOURCE_OF_TRUTH.md");
  assert.equal(legacyJson.current_architecture, "SINGLE_CONVERSATION_V1");
  assert.doesNotMatch(String(legacyJson.status), /^CANONICAL/i);
});

test("README is navigation only and cannot revive superseded architectures", () => {
  const readme = read("README.md");

  assert.match(readme, /There is exactly \*\*one\*\* canonical project Source of Truth:/);
  assert.ok(readme.includes("`/SOURCE_OF_TRUTH.md`"));
  assert.match(readme, /README is navigation only and is \*\*not\*\* project authority/);
  assert.match(readme, /\*\*Single Conversation \+ Disposable Chat \+ Persistent Source of Truth\*\*/);

  for (const forbidden of [
    /Planner \/ Executor V1 is active production/i,
    /active production orchestration mode is \*\*Three-Lane V1\*\*/i,
    /Canonical authority:\s*[\s\S]{0,400}SUPERVISOR_PLANNER_EXECUTOR_V1_SOURCE_OF_TRUTH/i,
    /Owner supplies .*Planner.*Executor.*URL/i,
  ]) {
    assert.doesNotMatch(readme, forbidden);
  }
});

test("authority contract is discoverable by root-level edits in hosted CI workflows", () => {
  const testsWorkflow = read(".github/workflows/supervisor-tests.yml");
  const integrityWorkflow = read(".github/workflows/supervisor-integrity.yml");

  for (const [name, workflow] of [
    ["Supervisor Tests", testsWorkflow],
    ["Supervisor Integrity", integrityWorkflow],
  ]) {
    assert.match(workflow, /['"]?SOURCE_OF_TRUTH\.md['"]?/);
  }

  assert.match(integrityWorkflow, /test\/source-of-truth-authority\.test\.mjs/);
});

test("MPC-006 reviewed completion and MPC-007 handoff remain SOURCE/QA only", () => {
  const canonical = read("SOURCE_OF_TRUTH.md");
  const plan = read("docs/project-control/MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md");
  const authority = canonical.split("### MAGASIN PROJECT CONTROL MPC-006 SOURCE/QA VERIFIED / MPC-007 next (2026-10-13)")[1];
  assert.ok(authority, "root canonical SOT must explicitly own the handoff");
  assert.match(authority, /MPC-006 SOURCE\/QA VERIFIED/);
  assert.match(authority, /MPC-007 is the sole NEXT executable task, SOURCE\/QA ONLY/);
  assert.match(authority, /NOT DEPLOYED\/NOT LIVE OWNER ACCEPTED/);
  assert.match(authority, /13\/13 changed file blob SHAs/);
  assert.match(authority, /STOP\/AUTOSTART_DISABLED/);
  assert.match(authority, /19b6f44d64332594ea70c0f68f06437c73359088/);
  assert.match(authority, /28edec449df6f3e4c91df0c6541602c60a44d464/);
  assert.match(authority, /38414811285/);
  assert.match(authority, /38414811176/);
  assert.match(authority, /38414811178/);
  assert.match(authority, /38414811424/);
  const immediate = plan.split("## Immediate next work")[1]?.split("## MPC-001 execution evidence")[0];
  assert.ok(immediate, "subordinate plan must have exactly one next-task section");
  assert.match(immediate, /MPC-007 is the sole next executable task \(SOURCE\/QA ONLY\)/);
  assert.doesNotMatch(immediate, /MPC-006 is the sole next executable task/);
  assert.match(plan, /\| MPC-005 \(VERIFIED\) \|/);
  assert.match(plan, /\| MPC-006 \(SOURCE\/QA VERIFIED\) \|/);
  assert.match(plan, /## MPC-005 completion evidence/);
  assert.match(plan, /## MPC-006 completion evidence/);
  assert.match(plan, /No MPC-007 execution before MPC-006 completion/);
  assert.match(plan, /no H4 deployment\/Owner live acceptance/i);
});

test("MPC plan-only changes trigger both hosted canonical authority regressions", () => {
  const mpcPlan = "docs/project-control/MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md";
  for (const workflowPath of [
    ".github/workflows/supervisor-tests.yml",
    ".github/workflows/supervisor-integrity.yml",
  ]) {
    const workflow = read(workflowPath);
    for (const section of ["push", "pull_request"]) {
      const start = workflow.indexOf("  " + section + ":");
      assert.notEqual(start, -1, workflowPath + " missing trigger " + section);
      const end = workflow.indexOf("\n  " + (section === "push" ? "pull_request" : "workflow_dispatch") + ":", start);
      assert.ok(end > start, workflowPath + " missing trigger boundary " + section);
      const trigger = workflow.slice(start, end);
      assert.ok(trigger.includes("'" + mpcPlan + "'"), workflowPath + " " + section + " omits MPC plan");
    }
  }
});
