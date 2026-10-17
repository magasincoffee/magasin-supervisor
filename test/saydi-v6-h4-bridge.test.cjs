const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root,'.github/workflows/saydi-v6-h4-transport.yml'),'utf8');
const ps = fs.readFileSync(path.join(root,'.github/scripts/saydi-v6-h4-cli-install.ps1'),'utf8');

test('only one bounded Owner request can reach the H4 transport', () => {
  for (const x of [
    "github.repository == 'magasincoffee/magasin-supervisor'",
    "github.actor == 'magasincoffee'",
    "github.triggering_actor == 'magasincoffee'",
    'github.run_attempt == 1', 'branches: [main]',
    '.github/saydi-v6-h4-source-stage-request.json',
    'REQUEST_MUST_BE_SINGLE_FILE_SINGLE_COMMIT',
    'SAYDI_V6_H4_SOURCE_STAGE_V1', 'STAGE_SOURCE_ONLY',
    'SAYDI_SHA_NOT_CURRENT_MAIN', 'github.rest.git.getRef',
    'magasin-h4a16il', 'DESKTOP-H4A16IL',
    'persist-credentials: false',
    'sc013-h4a16il-safe-deploy',
    'Stage verified SAYDI V6 source only on D'
  ]) assert.ok(workflow.includes(x), x);
  for (const forbidden of ['workflow_dispatch:', 'schedule:', 'pull_request:', 'issues:', 'actions/setup-python', 'INSTALL_CLI_ONLY']) {
    assert.ok(!workflow.includes(forbidden), forbidden);
  }
});

test('stage only: honest receipt, SHA-verified files, no existing versions overwritten', () => {
  for (const x of [
    "GITHUB_ACTOR_ID -ne '191064507'",
    "GITHUB_REF -ne 'refs/heads/main'",
    "GITHUB_EVENT_NAME -ne 'push'",
    "GITHUB_RUN_ATTEMPT -ne '1'",
    "'D:\\SAYDI_V6'",
    "Join-Path $source '02_SAYDI_CORE'",
    "RESOURCE_DISK_CAPACITY_HOLD", "SAYDI_MAIN_MOVED_HOLD",
    'RELEASE_EXISTS_NO_OVERWRITE', 'STAGING_REQUEST_ALREADY_USED',
    'SAYDI_SOURCE_REPARSE_DENIED',
    'V6_GIT_TREE_FILE_COUNT_MISMATCH', 'V6_STAGED_FILE_UNSAFE',
    'V6_STAGED_CONTENT_HASH_MISMATCH', 'V6_STAGED_SOT_HASH_MISMATCH',
    'V6_STAGED_GIT_BLOB_MISMATCH', 'V6_STAGED_SOT_GIT_BLOB_MISMATCH',
    'V6_UNTRACKED_SOURCE_FILE_DENIED', 'SAYDI_SOT_REPARSE_DENIED',
    "rev-parse --verify ($SaydiSha + ':00_PROJECT/SOURCE_OF_TRUTH.md')",
    'ls-tree -r --name-only', 'hash-object --no-filters',
    "rev-parse --verify ($SaydiSha + ':' + $gitPath)",
    "Copy-Item -LiteralPath $core",
    'Get-FileHash',
    '[System.IO.Directory]::Move($stage, $release)',
    'SOURCE_ONLY_STAGED_ON_D_NO_PYTHON',
    'source-stage-receipt.json',
    'copied_tree_sha256_verified = $true',
    'canonical_git_tree_verified = $true',
    'python_qualified = $false',
    'cli_installed = $false',
    'cli_executed = $false',
    'model_started = $false',
    'saydi_start_authenticated = $false',
    'supervisor_control_modified = $false',
    'previous_versions_modified = $false'
  ]) assert.ok(ps.includes(x),x);
});

test('a shared Supervisor runner must never start a candidate interpreter or modify old system', () => {
  for (const bad of [
    "rev-parse --verify ('HEAD:'", "rev-parse --verify 'HEAD:",
    'Resolve-TrustedSharedPython', 'Get-AuthenticodeSignature',
    'python.exe', 'venv', 'ensurepip', ' -m ', ' -c ',
    'Start-Service', 'Stop-Service', 'Start-Process', 'Stop-Process',
    'Remove-Item', 'Set-Acl', 'icacls', 'C:\\Users\\admin',
    'owner_stop', 'AUTOSTART_DISABLED', 'dispatch_gateway.py',
    'Invoke-WebRequest', 'Expand-Archive', 'pip install',
    'Vieneu(', 'saydi_audiobook --help',
  ]) assert.ok(!ps.includes(bad), bad);
});
