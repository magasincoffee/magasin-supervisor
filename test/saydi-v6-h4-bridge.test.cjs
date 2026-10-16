const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/saydi-v6-h4-transport.yml'), 'utf8');
const ps = fs.readFileSync(path.join(root, '.github/scripts/saydi-v6-h4-cli-install.ps1'), 'utf8');

test('single-file owner-only request enters a dedicated protected transport', () => {
  for (const marker of [
    "github.repository == 'magasincoffee/magasin-supervisor'",
    "github.actor == 'magasincoffee'",
    "github.triggering_actor == 'magasincoffee'",
    "github.run_attempt == 1", "on:", "push:", "branches: [main]",
    "'.github/saydi-v6-h4-install-request.json'",
    "REQUEST_MUST_BE_SINGLE_FILE_SINGLE_COMMIT",
    "SAYDI_SHA_NOT_CURRENT_MAIN",
    "github.rest.git.getRef", "['added', 'modified']",
    "persist-credentials: false", "magasin-h4a16il",
    "DESKTOP-H4A16IL", "sc013-h4a16il-safe-deploy",
  ]) assert.ok(workflow.includes(marker), marker);
  for (const denied of ["workflow_dispatch:", "schedule:", "pull_request:", "issues:"]) {
    assert.ok(!workflow.includes(denied), denied);
  }
});
test('Supervisor runner is transport only; no Supervisor controls changed', () => {
  for (const marker of [
    "UNTRUSTED_OWNER_IDENTITY", "GITHUB_ACTOR_ID -ne '191064507'",
    "GITHUB_REF -ne 'refs/heads/main'",
    "GITHUB_EVENT_NAME -ne 'push'", "GITHUB_RUN_ATTEMPT -ne '1'",
    "'D:\\SAYDI_V6'", "Join-Path $source '02_SAYDI_CORE'",
    "RESOURCE_DISK_CAPACITY_HOLD", "SAYDI_MAIN_MOVED_HOLD",
    "RELEASE_EXISTS_NO_OVERWRITE", "SAYDI_SOURCE_REPARSE_DENIED",
    "V6_SOURCE_STATIC_SYNTAX_FAILED", "CLI_FILES_INSTALLED_ON_D_NOT_EXECUTED",
    "static_ast_passed = $true", "saydi_cli_executed = $false",
    "model_started = $false", "supervisor_control_modified = $false",
  ]) assert.ok(ps.includes(marker), marker);
  for (const denied of [
    'Stop-Service', 'Start-Service', 'Stop-Process', 'Start-Process',
    'Remove-Item', 'C:\\SAYDI\\output', 'owner_stop', 'AUTOSTART_DISABLED',
    'dispatch_gateway.py', 'start_audiobook_chapter_1', 'Vieneu(',
    'pip install', 'winget install', '-m saydi_audiobook',
  ]) assert.ok(!ps.includes(denied), denied);
});
test('git-pinned installation is additive and SHA verified', () => {
  for (const marker of [
    "'saydi-source'", "git.exe", "Get-FileHash",
    "Copy-Item -LiteralPath $core",
    "Join-Path $release '.venv'", "Join-Path $destination $SaydiSha",
    "Join-Path $shaNamespace $RequestId", "V6_PYTHON_ENVIRONMENT_FAILED",
    "V6_VENV_CREATION_FAILED", "[System.IO.Directory]::Move($stage, $release)",
    "STAGING_REQUEST_ALREADY_USED",
    "ast.parse(", "-I -c $astProbe", "sys.base_prefix",
    "Receipt acts as the only successful-install commit marker",
    "Get-Item -LiteralPath $Path",
  ]) assert.ok(ps.includes(marker), marker);
});
