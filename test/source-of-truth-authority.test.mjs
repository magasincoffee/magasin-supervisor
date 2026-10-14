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

test("MPC-007 verified completion and MPC-008 handoff remain SOURCE/QA only", () => {
  const canonical = read("SOURCE_OF_TRUTH.md");
  const plan = read("docs/project-control/MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md");
  assert.match(canonical, /MPC-006 SOURCE\/QA VERIFIED \(historical handoff/);
  const newAuthority = canonical.split("### MAGASIN PROJECT CONTROL MPC-007 SOURCE/QA VERIFIED / MPC-008 next (2026-10-14)")[1];
  assert.ok(newAuthority, "canonical root SOT must own current MPC-008 handoff");
  assert.match(newAuthority, /MPC-007 SOURCE\/QA VERIFIED; NOT INSTALLED/);
  assert.match(newAuthority, /65f6ed4e93152d984cb8a3ee0f72a1d9bacda8f9/);
  assert.match(newAuthority, /33b884025e333a36feff63a6b0525a12acfe836d/);
  for (const run of ["38507898008", "38507898006", "38507898005", "38507898009"]) {
    assert.ok(newAuthority.includes(run), "missing exact-head CI " + run);
  }
  assert.match(newAuthority, /all 7\/7 changed/);
  assert.match(newAuthority, /MPC-008 is the sole NEXT executable task, SOURCE\/QA ONLY/);
  assert.match(newAuthority, /STOP\/AUTOSTART_DISABLED/);
  assert.match(newAuthority, /MPC-009 remains independently blocked/);
  const immediate = plan.split("## Immediate next work")[1]?.split("## MPC-001 execution evidence")[0];
  assert.ok(immediate, "single current next-task declaration required");
  assert.match(immediate, /MPC-008 is the sole next executable task \(SOURCE\/QA ONLY\)/);
  assert.doesNotMatch(immediate, /MPC-007 is the sole next executable task/);
  const historical = plan.split("## MPC-001 execution evidence")[1];
  assert.ok(historical, "historical evidence must remain inspectable");
  const authorizedLine = "**MPC-008 is the sole next executable task (SOURCE/QA ONLY)**";
  const nextPattern = /\bNext authorized(?: backlog)? task\s*:\s*MPC-\d{3}|\bCurrent next task is MPC-\d{3}|\bCurrent next authorized task\s*:\s*MPC-\d{3}|\bMPC-\d{3} is NEXT\b|\bMPC-\d{3} is the sole next executable task\b|\bMPC-\d{3} NEXT\b/i;
  function assertSingleNextAuthority(candidate) {
    const lines = candidate.split("\n");
    assert.equal(lines.filter(line => line.includes(authorizedLine)).length, 1, "one authorized immediate MPC-008 declaration");
    assert.match(lines[2], /^Status: .*; MPC-008 NEXT$/, "status header must agree on MPC-008");
    const immediateStart = candidate.indexOf("## Immediate next work");
    const immediateEnd = candidate.indexOf("## MPC-001 execution evidence");
    assert.ok(immediateStart !== -1 && immediateEnd > immediateStart, "immediate scope markers required");
    for (const [index, line] of lines.entries()) {
      if (index === 2) continue; // separately verified exact status header
      if (line.includes(authorizedLine)) {
        const position = candidate.indexOf(line);
        assert.ok(position > immediateStart && position < immediateEnd, "only immediate section may authorize MPC-008");
        continue;
      }
      assert.doesNotMatch(line, nextPattern, "competing active MPC NEXT claim at full-plan line " + (index + 1));
    }
  }
  assertSingleNextAuthority(plan);
  for (const section of ["## Architecture boundaries", "## Source contracts", "## Delivery tasks", "## Release gate sequence", "## MPC-001 execution evidence"]) {
    assert.throws(
      () => assertSingleNextAuthority(plan.replace(section, section + "\nMPC-007 is NEXT")),
      /competing active MPC NEXT/,
      "authority guard must reject a stale NEXT instruction in " + section
    );
  }
  assert.match(historical, /Historical 2026-10-12 handoff: MPC-003 was next/);
  assert.match(historical, /Historical 2026-10-12 handoff: MPC-004 was next/);
  assert.match(plan, /Historical 2026-10-12 handoff after MPC-004:.*MPC-005 was next/);
  assert.doesNotMatch(plan, /Historical 2026-10-12 handoff[^\n]*MPC-007 was next/);
  assert.match(plan, /Historical 2026-10-13 handoff: MPC-007 was next/);
  assert.match(plan, /\| MPC-006 \(SOURCE\/QA VERIFIED\) \|/);
  assert.match(plan, /\| MPC-007 \(SOURCE\/QA VERIFIED\) \|/);
  assert.match(plan, /## MPC-007 completion evidence/);
  assert.match(plan, /no live Owner decision issuer/);
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
