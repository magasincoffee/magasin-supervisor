import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const workflow = new URL('../.github/workflows/sc013-coordinator-readonly-stage.yml', import.meta.url);
const script = new URL('../.github/scripts/sc013-coordinator-readonly-stage.ps1', import.meta.url);
const integrity = new URL('../.github/workflows/supervisor-integrity.yml', import.meta.url);
const sot = new URL('../SOURCE_OF_TRUTH.md', import.meta.url);

test('Coordinator staging must be explicitly triggered, never source push or cron', async () => {
  const s = await fs.readFile(workflow, 'utf8');
  assert.match(s, /workflow_dispatch:/);
  assert.match(s, /\.github\/sc013-coordinator-stage-request\.json/);
  assert.doesNotMatch(s, /^\s+schedule:/m);
  assert.doesNotMatch(s, /src\/\*\*/);
  assert.match(s, /contents: read/);
  assert.doesNotMatch(s, /issues: write|contents: write/);
  assert.match(s, /runs-on: \[self-hosted, Windows, X64\]/);
  assert.match(s, /TARGET_MUTATION_SKIPPED=True/);
  assert.match(s, /ref: \$\{\{ github\.event_name == 'push' && github\.sha \|\| inputs\.exact_main_sha \}\}/);
  assert.match(s, /group: sc013-h4a16il-safe-deploy/);
  assert.match(s, /cancel-in-progress: false/);
});

test('Coordinator staging script pins main and copies only 3 approved files to isolated D:', async () => {
  const s = await fs.readFile(script, 'utf8');
  for (const marker of [
    'WRONG_TARGET_MACHINE', 'CHECKOUT_NOT_EXACT_SHA', 'LIVE_MAIN_NOT_VERIFIED',
    'MAIN_MOVED_ABORT_STAGE', 'SOT_STAGE_AUTHORITY_NOT_PRESENT',
    'D_STAGING_SPACE_LOW', 'STAGE_ALREADY_EXISTS_INSPECT_FIRST',
    'STAGED_HASH_MISMATCH', 'NODE_SYNTAX_CHECK_FAILED', 'PYTHON_SYNTAX_CHECK_FAILED',
    'D:\\MAGASIN_ROBOTS\\deploy\\sc013-coordinator-readonly',
    'src/coordinator/sot-adapter.mjs',
    'src/coordinator/sot-preflight-cli.mjs',
    'src/coordinator/sot-preflight-python-bridge.py',
    'MAGASIN_SC013_COORDINATOR_STAGE_RESULT_V1',
    'COORDINATOR_STAGE_PASS=True', 'STAGE_NO_RUNTIME_MUTATION=True',
    'STAGE_NO_CHATGPT_OUTBOUND=True'
  ]) assert.ok(s.includes(marker), marker);
  assert.match(s, /merge-base --is-ancestor/);
  assert.match(s, /Get-FileHash -LiteralPath/);
  assert.match(s, /-Algorithm SHA256/);
  assert.match(s, /ast\.parse/);
  assert.doesNotMatch(s, /(?<![\w-])Start-Process\b|(?<![\w-])Stop-Process\b|schtasks(?:\.exe)?\b|Set-ScheduledTask\b|Invoke-Expression\b/i);
  assert.doesNotMatch(s, /Copy-Item[^\n]*robots\\coordinator\\coordinator\.py/);
  assert.doesNotMatch(s, /Invoke-RestMethod|Invoke-WebRequest/);
});

test('staging manifest explicitly denies installation, execution and worker changes', async () => {
  const s = await fs.readFile(script, 'utf8');
  for (const flag of [
    'installation_performed=$false', 'coordinator_python_modified=$false',
    'supervisor_started_or_stopped=$false','github_gateway_modified=$false',
    'chatgpt_outbound=$false', 'business_execution_qualified=$false',
    'STAGED_READ_ONLY_NOT_INSTALLED'
  ]) assert.ok(s.includes(flag), flag);
});

test('SOT explicitly authorizes isolated staging, not business operations', async () => {
  const s = await fs.readFile(sot, 'utf8');
  assert.match(s, /### SC-013 Coordinator isolated read-only staging \(Owner 2026-10-09\)/);
  assert.match(s, /NOT installed/);
  assert.match(s, /STOP\/OFF remain authoritative/);
  assert.match(s, /A separate \*\*future\*\* SOT-revised PR/);
  const i = await fs.readFile(integrity, 'utf8');
  assert.match(i, /sc013-coordinator-readonly-stage\.yml/);
  assert.match(i, /test\/sc013-coordinator-readonly-stage\.test\.mjs/);
});

test('required three source modules are present without hidden executor', async () => {
  for (const f of [
    './src/coordinator/sot-adapter.mjs',
    './src/coordinator/sot-preflight-cli.mjs',
    './src/coordinator/sot-preflight-python-bridge.py'
  ]) {
    const s = await fs.readFile(new URL(f, ROOT), 'utf8');
    assert.ok(s.length > 100);
    if (f.endsWith('.mjs')) {
      assert.doesNotMatch(s, /\bspawn\s*\(.*(?:supervisor|chrome|powershell)/i);
    } else {
      assert.match(s, /mode=ro/);
      assert.match(s, /execution_qualified/);
      assert.match(s, /dispatched/);
    }
  }
});
