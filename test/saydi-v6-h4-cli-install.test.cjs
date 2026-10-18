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
    'persist-credentials: false','actions/setup-python@v5',
    'PSExecutionPolicyPreference: Bypass',
    "SAYDI_BOOTSTRAP_PYTHON: ${{ steps.setup_python.outputs['python-path'] }}"
  ]) assert.ok(wf.includes(marker),marker);
  assert.match(wf, /id: setup_python\r?\n\s+uses: actions\/setup-python@v5/, 'setup-python step');
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
    'RUNNER_PYTHON_TOOLCACHE_MISSING','RUNNER_PYTHON_OUTSIDE_TOOLCACHE',
    'RUNNER_PYTHON_REPARSE_DENIED','RUNNER_PYTHON_VERSION_INVALID'])
      assert.ok(ps.includes(marker),marker);
  for (const forbidden of ['Remove-Item','Stop-Service','Start-Service','Stop-Process',
      'Start-Process','pip install','winget install','C:\\Users\\admin'])
      assert.ok(!ps.includes(forbidden),forbidden);
});

test('honest CLI only with persistent launcher but zero SAYDI execution', () => {
  for(const marker of ['saydi_v6_source.pth','saydi-audiobook.cmd',
      'V6_MODULE_REGISTRATION_FAILED','V6_LAUNCHER_MISSING',
      'V6_STATIC_SOURCE_PARSE_FAILED',"& $trustedPython -I -c $astProbe $finalCore",
      "Join-Path $release '02_SAYDI_CORE'",'CLI_FILES_INSTALLED_ON_D_SAYDI_NOT_EXECUTED',
      'cli_executed = $false','module_import_attempted = $false',
      'model_started = $false','saydi_start_authenticated = $false',
      'supervisor_control_modified = $false'])
       assert.ok(ps.includes(marker),marker);
});
