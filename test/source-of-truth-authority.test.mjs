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
