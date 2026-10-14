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

test("MPC-008 verified source-only completion gates MPC-009 and authorizes only MPC-010 independent QA", () => {
  const canonical = read("SOURCE_OF_TRUTH.md");
  const plan = read("docs/project-control/MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md");
  const oldAuthority = canonical.split("### MAGASIN PROJECT CONTROL MPC-007 SOURCE/QA VERIFIED (historical MPC-008 handoff, 2026-10-14)")[1];
  assert.ok(oldAuthority, "MPC-007 history must remain");
  const section = canonical.split("### MAGASIN PROJECT CONTROL MPC-008 SOURCE/QA VERIFIED / MPC-010 independent QA next; MPC-009 BLOCKED (2026-10-14)")[1];
  assert.ok(section, "root SOT must own MPC-008 exact-main handoff");
  const current = section.split("### SC-013 H4 local MCP GitHub receipt Windows-shell repair")[0];
  assert.ok(current, "MPC-008 authority must not overwrite SC-013 content");
  assert.match(current, /MPC-008 SOURCE\/QA VERIFIED; NOT H4 INSTALLED/);
  assert.match(current, /NOT_VERIFIED/);
  assert.match(current, /NOT_QUALIFIED/);
  assert.match(current, /2943fcdc15fddb0ed87d8f4f68d8a5b61249b3a6/);
  assert.match(current, /ddc7ef48ba16629cdcb2cdc9338cd08f837c5c01/);
  for (const id of ["38546352392","38546352385","38546352364","38546352357"])
    assert.ok(current.includes(id), "missing exact-head CI " + id);
  assert.match(current, /5\/5 inspected code\/test file blobs/);
  assert.match(current, /MPC-009 BLOCKED/);
  assert.match(current, /MPC-010 is the sole NEXT executable MPC task, SOURCE\/QA independent slice ONLY/);
  assert.match(current, /Do not declare MPC-010 fully complete/);
  assert.match(canonical, /whole-ledger/i, "SC-013 whole-ledger authority must remain");
  assert.match(canonical, /AUTOSTART_DISABLED/);

  const immediate = plan.split("## Immediate next work")[1]?.split("## MPC-001 execution evidence")[0];
  assert.ok(immediate, "single current next-task declaration required");
  assert.match(immediate, /MPC-010 is the sole next executable MPC task \(SOURCE\/QA ONLY, independent tests\)/);
  assert.match(immediate, /MPC-009 is BLOCKED/);
  assert.match(immediate, /No Owner START/);
  const historical = plan.split("## MPC-001 execution evidence")[1];
  assert.ok(historical, "historical evidence must remain inspectable");
  const allowedLine = "**MPC-010 is the sole next executable MPC task (SOURCE/QA ONLY, independent tests)**";
  const staleNext = /\bNext authorized(?: backlog)? task\s*:\s*MPC-\d{3}|\bCurrent next task is MPC-\d{3}|\bCurrent next authorized task\s*:\s*MPC-\d{3}|\bMPC-\d{3} is NEXT\b|\bMPC-\d{3} is the sole next executable(?: MPC)? task\b|\bMPC-\d{3} NEXT\b/i;
  function requireSingleNext(candidate) {
    const lines = candidate.split("\n");
    assert.equal(lines.filter(line=>line.startsWith(allowedLine)).length,1,
      "only one explicitly authorized MPC-010 SOURCE/QA next declaration");
    assert.match(lines[2], /^Status: .*; MPC-009 BLOCKED \(separate SC-013 P1–P3\); MPC-010 SOURCE\/QA NEXT \(independent QA only\)$/,
      "status header must agree on MPC-009 hold and MPC-010 limited next");
    const at=candidate.indexOf("## Immediate next work");
    const after=candidate.indexOf("## MPC-001 execution evidence");
    assert.ok(at>=0&&after>at,"must have unambiguous immediate/historical sections");
    for (const [index,line] of lines.entries()) {
      if(index===2)continue; // exact allowed header separately verified
      if(line.startsWith(allowedLine)){
        const pos=candidate.indexOf(line);
        assert.ok(pos>at&&pos<after,"only immediate instruction can authorize MPC-010");
        assert.doesNotMatch(line.slice(allowedLine.length),staleNext,"competing NEXT on authorized line");
        continue;
      }
      assert.doesNotMatch(line,staleNext,"competing active MPC NEXT in whole plan at line "+(index+1));
    }
  }
  requireSingleNext(plan);
  for(const section of ["## Architecture boundaries","## Source contracts","## Delivery tasks",
    "## Release gate sequence","## MPC-001 execution evidence","## MPC-008 completion evidence"]){
    for (const conflict of ["MPC-008 is NEXT", "MPC-009 is the sole next executable MPC task",
      "MPC-009 is the sole next executable task"]) {
      assert.throws(() => requireSingleNext(plan.replace(section, section + "\n" + conflict)),
        /competing active MPC NEXT/,
        "must detect competing task authority '" + conflict + "' within " + section);
    }
  }
  assert.match(historical, /Historical 2026-10-12 handoff: MPC-003 was next/);
  assert.match(historical, /Historical 2026-10-12 handoff: MPC-004 was next/);
  assert.match(plan, /Historical 2026-10-12 handoff after MPC-004:.*MPC-005 was next/);
  assert.doesNotMatch(plan, /Historical 2026-10-12 handoff[^\n]*MPC-007 was next/);
  assert.match(plan, /Historical 2026-10-13 handoff: MPC-007 was next/);
  assert.match(plan, /\| MPC-007 \(SOURCE\/QA VERIFIED\) \|/);
  assert.match(plan, /\| MPC-008 \(SOURCE\/QA VERIFIED\) \|/);
  assert.match(plan, /\| MPC-009 \(BLOCKED\) \|/);
  assert.match(plan, /\| MPC-010 \(SOURCE\/QA PARTIAL NEXT\) \|/);
  assert.match(plan, /## MPC-008 completion evidence/);
  assert.match(plan, /no H4 installation or Owner live acceptance/);
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
