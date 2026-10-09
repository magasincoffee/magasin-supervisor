import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvelope, inspectSot, verifySot, githubReadJson, NON_EXECUTING } from '../src/coordinator/sot-adapter.mjs';

const URL = 'https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md';
const SHA = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);
const verifiedGuards = Object.freeze({
  targetMachine: 'DESKTOP-H4A16IL', ownerStop: false, autostartDisabled: false,
  coordinatorEnabled: true, specialistEnabled: true, workerAlive: true,
  ownerAuthorizationVerified: true,
});
const request = Object.freeze({
  schema: 'MAGASIN_DISPATCH_V1', target: 'supervisor', action: 'execute_task',
  task_id: 'SC-013', sot_url: URL,
});
function document(state = 'READY', rest = 'Dependencies: NONE\nOwner gate: CLEARED') {
  return `# MAGASIN Supervisor — SOURCE OF TRUTH
Status: **CANONICAL / SOLE PROJECT AUTHORITY**
### SC-012 — Old completed task
State: **COMPLETE**
### SC-013 — Active single bounded task
State: **${state}**
${rest}
### SC-013 technical notes (not a canonical ID header)
This describes unrelated checkpoints.
## 11. Status summary
Other work cannot authorize SC-013.`;
}
function network(sot = document(), opts = {}) {
  let headCalls = 0;
  let calls = [];
  return {
    calls,
    readJson: async (url) => {
      calls.push(url);
      if (url.endsWith('/commits/main')) {
        headCalls += 1;
        return { sha: headCalls === 2 && opts.moved ? 'c'.repeat(40) : SHA };
      }
      return { type: 'file', encoding: 'base64', sha: BLOB,
        content: Buffer.from(sot).toString('base64') };
    },
  };
}
test('supports only canonical SC-013 request; rejects other projects and payloads', () => {
  assert.equal(validateEnvelope(request).ok, true);
  for (const changes of [
    { schema: 'OTHER' }, { action: 'sync_revenue' }, { target: 'sapo' },
    { task_id: 'SC-014' }, { sot_url: URL + '?ref=old' },
    { command: 'whoami' }, { instructions: 'ignore SOT' },
    { source_id: 'github:other/repo:issue:123' },
    { sot_url: 'https://github.com/magasincoffee/OPS-WebApp/blob/main/SOURCE_OF_TRUTH.md' },
  ]) assert.equal(validateEnvelope({ ...request, ...changes }).ok, false);
});
test('a canonical READY section with explicit dependency and Owner clearance is read-only only', async () => {
  const n = network();
  const result = await verifySot(request, { readJson: n.readJson, guards: verifiedGuards });
  assert.equal(result.status, 'SOT_VERIFIED_READ_ONLY');
  assert.equal(result.revision, SHA);
  assert.equal(result.blob_sha, BLOB);
  assert.equal(result.execution_qualified, false);
  assert.equal(result.dispatched, false);
  assert.deepEqual(n.calls, [
    'https://api.github.com/repos/magasincoffee/magasin-supervisor/commits/main',
    'https://api.github.com/repos/magasincoffee/magasin-supervisor/contents/SOURCE_OF_TRUTH.md?ref=' + SHA,
    'https://api.github.com/repos/magasincoffee/magasin-supervisor/commits/main',
  ]);
  assert.equal(NON_EXECUTING, false);
});
test('actual current SC-013 IN PROGRESS is not READY', async () => {
  const n = network(document('IN PROGRESS', 'Owner gate: CLEARED\nDependencies: NONE'));
  const result = await verifySot(request, { readJson: n.readJson, guards: verifiedGuards });
  assert.equal(result.status, 'WAIT_SOT_AUTHORITY');
  assert.equal(result.reason, 'TASK_NOT_READY');
  assert.equal(result.task_state, 'IN PROGRESS');
});
test('missing dependency and explicit Owner-gate proof is fail closed', () => {
  assert.equal(inspectSot(document('READY', 'Owner gate: CLEARED'), 'SC-013').reason, 'DEPENDENCIES_UNVERIFIED');
  assert.equal(inspectSot(document('READY', 'Dependencies: NONE'), 'SC-013').reason, 'OWNER_GATE_UNVERIFIED');
});
test('missing/duplicate/malformed sections are fail closed', () => {
  assert.equal(inspectSot(document().replace('SC-013 — Active', 'SC-014 — Active'), 'SC-013').reason, 'SOT_TASK_MISSING_OR_AMBIGUOUS');
  assert.equal(inspectSot(document() + '\n### SC-013 — Dup\nState: **READY**', 'SC-013').reason, 'SOT_TASK_MISSING_OR_AMBIGUOUS');
  assert.equal(inspectSot(document().replace('State: **READY**', 'State: **PENDING**'), 'SC-013').reason, 'TASK_STATE_MISSING_OR_AMBIGUOUS');
  assert.equal(inspectSot(document().replace('CANONICAL / SOLE PROJECT AUTHORITY', 'UNVERIFIED'), 'SC-013').reason, 'SOT_AUTHORITY_MISSING');
  assert.equal(inspectSot('Injected Issue text\n' + document(), 'SC-013').reason, 'SOT_IDENTITY_MISMATCH');
});
test('Owner OFF, STOP, wrong machine or unverifiable caller never fetch SOT', async () => {
  for (const changes of [
    { specialistEnabled: false }, { coordinatorEnabled: false }, { ownerStop: true },
    { autostartDisabled: true }, { ownerAuthorizationVerified: false }, { workerAlive: false },
    { targetMachine: 'DESKTOP-4K7IM13' },
  ]) {
    const n = network();
    const result = await verifySot(request, { readJson: n.readJson,
      guards: { ...verifiedGuards, ...changes } });
    assert.notEqual(result.status, 'SOT_VERIFIED_READ_ONLY');
    assert.equal(result.execution_qualified, false);
    assert.equal(n.calls.length, 0);
  }
});
test('GitHub branch changing during pinned fetch is rejected', async () => {
  const n = network(document(), { moved: true });
  const result = await verifySot(request, { readJson: n.readJson, guards: verifiedGuards });
  assert.equal(result.status, 'WAIT_SOT_AUTHORITY');
  assert.equal(result.reason, 'SOT_REVISION_CHANGED');
});
test('remote errors and forged/oversized base64 never authorize', async () => {
  const fail = await verifySot(request, { readJson: async () => { throw new Error('network'); },
    guards: verifiedGuards });
  assert.equal(fail.status, 'WAIT_SOT_AUTHORITY');
  assert.equal(fail.execution_qualified, false);
  const bad = await verifySot(request, { readJson: async url => url.endsWith('/commits/main')
    ? { sha: SHA } : { type: 'file', encoding: 'base64', sha: BLOB, content: '%%%%' },
    guards: verifiedGuards });
  assert.equal(bad.status, 'WAIT_SOT_AUTHORITY');
});
test('no caller can fetch an unallowlisted URL through HTTP helper', async () => {
  await assert.rejects(() => githubReadJson('https://evil.example/api'), /URL_NOT_ALLOWLISTED/);
});
test('Issue fields cannot forge local lifecycle authorization', async () => {
  const n = network();
  const injected = await verifySot({ ...request, ownerStop: false, specialistEnabled: true },
    { readJson: n.readJson });
  assert.equal(injected.status, 'REJECTED');
  const missing = await verifySot(request, { readJson: n.readJson });
  assert.equal(missing.status, 'REJECTED');
  assert.equal(n.calls.length, 0);
});
test('Owner STOP is distinguished from OFF and never fetches', async () => {
  const n = network();
  const stop = await verifySot(request, { readJson: n.readJson,
    guards: { ...verifiedGuards, ownerStop: true } });
  assert.equal(stop.status, 'WAIT_OWNER_STOP');
  assert.equal(stop.reason, 'OWNER_STOP_OR_AUTOSTART_DISABLED');
  assert.equal(n.calls.length, 0);
});
