const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname,'..');
const wf = fs.readFileSync(path.join(root,'.github/workflows/saydi-v6-h4-cli-install.yml'),'utf8');
const ps = fs.readFileSync(path.join(root,'.github/scripts/saydi-v6-h4-cli-only-install.ps1'),'utf8');

test('only an Owner one-file main push enters the H4 install lane', () => {
  for (const marker of ["github.repository == 'magasincoffee/magasin-supervisor'",
    "github.actor == 'magasincoffee'", "github.triggering_actor == 'magasincoffee'",
    'github.run_attempt == 1', "GIT_CONFIG_KEY_0: core.autocrlf",
    "GIT_CONFIG_VALUE_0: 'false'",
    'REQUEST_MUST_BE_SINGLE_FILE_SINGLE_COMMIT',
    'SAYDI_V6_H4_CLI_INSTALL_V1','INSTALL_CLI_ONLY',
    'SAYDI_SHA_NOT_CURRENT_MAIN','magasin-h4a16il',
    'sc013-h4a16il-safe-deploy','DESKTOP-H4A16IL',
    'persist-credentials: false',
    'SHA256-pinned portable Python on D (no Python execution)'
  ]) assert.ok(wf.includes(marker),marker);
  assert.ok(!wf.includes('actions/setup-python@v5'), 'do not execute setup-python registry installer');
  assert.ok(!wf.includes('id: setup_python'), 'do not use toolcache setup');
  assert.ok(!/\n    env:\r?\n      PSExecutionPolicyPreference: Bypass/.test(wf), 'must not elevate whole job');
  for (const forbidden of ['workflow_dispatch:','  schedule:','  pull_request:','  issues:'])
    assert.ok(!wf.includes(forbidden),forbidden);
});

test('install source is fully Git blob verified and no old release overwritten', () => {
  for(const marker of ['V6_GIT_TREE_FILE_COUNT_MISMATCH',
    'V6_STAGED_GIT_BLOB_MISMATCH','V6_STAGED_SOT_GIT_BLOB_MISMATCH',
    'SAYDI_SOURCE_REPARSE_DENIED','V6_STAGED_CONTENT_HASH_MISMATCH',
    'RESOURCE_DISK_CAPACITY_HOLD','SAYDI_MAIN_MOVED_HOLD',
    'STAGING_REQUEST_ALREADY_USED','RELEASE_EXISTS_NO_OVERWRITE',
    'Get-FileHash','[System.IO.Directory]::Move($stage, $release)',
    'V6_PYTHON_ARCHIVE_HASH_MISMATCH', 'V6_PYTHON_ARCHIVE_ENTRY_UNSAFE',
    'V6_PYTHON_ARCHIVE_INCOMPLETE','V6_EMBEDDED_PATH_FILE_UNSAFE',
    'Get-FileHash','python-3.12.10-embed-amd64.zip',
    '4ACBED6DD1C744B0376E3B1CF57CE906F9DC9E95E68824584C8099A63025A3C3'])
      assert.ok(ps.includes(marker),marker);
  for (const forbidden of ['Remove-Item','Stop-Service','Start-Service','Stop-Process',
      'Start-Process','pip install','winget install','New-ItemProperty',
      'Set-ItemProperty','Registry::','reg.exe','Remove-ItemProperty'])
      assert.ok(!ps.includes(forbidden),forbidden);
});

test('honest CLI only with persistent launcher but zero SAYDI execution', () => {
  for(const marker of ['python312._pth','saydi-audiobook.cmd',
      'V6_EMBEDDED_PATH_WRITE_FAILED','V6_LAUNCHER_MISSING',
      'V6_PYTHON_ARCHIVE_HASH_MISMATCH',"$pathData",
      "Join-Path $stage 'runtime'",'CLI_FILES_INSTALLED_ON_D_SAYDI_NOT_EXECUTED',
      'cli_executed = $false','module_import_attempted = $false',
      'model_started = $false','saydi_start_authenticated = $false',
      'supervisor_control_modified = $false'])
       assert.ok(ps.includes(marker),marker);
});

test('bootstrap downloads PSF SHA256-pinned portable runtime, never runs Python', () => {
  assert.ok(ps.includes('https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip'));
  assert.ok(ps.includes("Get-FileHash -LiteralPath $archivePath -Algorithm SHA256"));
  assert.ok(ps.includes('V6_PYTHON_ARCHIVE_HASH_MISMATCH'));
  assert.ok(ps.includes('V6_PYTHON_ARCHIVE_ENTRY_UNSAFE'));
  assert.ok(ps.includes('..\\02_SAYDI_CORE\\src'), 'relative isolated embedded source path');
  assert.ok(ps.includes('python_runtime_executed = $false'));
  assert.ok(ps.includes('python_qualified = $false'));
  assert.ok(!ps.includes('Get-AuthenticodeSignature'));
  assert.ok(!ps.includes('RUNNER_TOOL_CACHE'));
  assert.ok(!ps.includes('SAYDI_BOOTSTRAP_PYTHON'));
  assert.ok(!ps.includes(' -m venv '));
  assert.ok(!wf.includes('setup-python@'));
  assert.ok(!wf.includes('SAYDI_BOOTSTRAP_PYTHON'));
});
