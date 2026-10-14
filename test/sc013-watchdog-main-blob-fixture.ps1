$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
# Hosted-only disposable Git repository; never touch H4, worker or SQLite.
$source = Join-Path $PSScriptRoot '..\.github\scripts\sc013-watchdog-owner-onefile-apply.ps1'
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if(@($errors).Count -ne 0){throw 'GIT_BLOB_FIXTURE_POWERSHELL_PARSE_FAILED'}
$nodes=@($ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
  $node.Name -eq 'Assert-ApprovedMainBlob'
},$true))
if($nodes.Count -ne 1){throw 'GIT_BLOB_HELPER_MISSING'}
. ([scriptblock]::Create($nodes[0].Extent.Text))
$root=Join-Path $env:RUNNER_TEMP ('sc013-watchdog-main-blob-'+[guid]::NewGuid().ToString('N'))
$origin=Join-Path $root 'fake-origin'
$stage=Join-Path $root 'fake-protected-stage'
New-Item -ItemType Directory -Path $origin,$stage -Force|Out-Null
try {
  & git init -q $origin
  if($LASTEXITCODE -ne 0){throw 'GIT_FIXTURE_INIT_FAILED'}
  & git -C $origin config user.email 'fixture@example.invalid'
  & git -C $origin config user.name 'SC013 Fixture'
  New-Item -ItemType Directory -Path (Join-Path $origin 'windows')|Out-Null
  Set-Content -LiteralPath (Join-Path $origin 'windows\local-watchdog.ps1') -Value 'approved fake source' -Encoding ASCII
  & git -C $origin add -- windows/local-watchdog.ps1
  & git -C $origin commit -q -m 'synthetic approved watchdog'
  if($LASTEXITCODE -ne 0){throw 'GIT_FIXTURE_COMMIT_FAILED'}
  & git -C $origin branch -M main
  $RepoUrl=$origin
  $ExpectedMainSha=(@(& git -C $origin rev-parse HEAD))[0]
  $ExpectedBlob=(@(& git -C $origin rev-parse 'HEAD:windows/local-watchdog.ps1'))[0]
  if($ExpectedMainSha -notmatch '^[a-f0-9]{40}$' -or $ExpectedBlob -notmatch '^[a-f0-9]{40}$'){
    throw 'GIT_FIXTURE_INVALID_IDENTITIES'
  }
  Assert-ApprovedMainBlob
  $approved=$ExpectedBlob
  $ExpectedBlob='0000000000000000000000000000000000000000'
  $held=$false
  try{Assert-ApprovedMainBlob}catch{if($_.Exception.Message -match 'GIT_MAIN_PROOF_WATCHDOG_BLOB_MISMATCH'){$held=$true}else{throw}}
  if(-not $held){throw 'STALE_APPROVED_BLOB_WAS_ACCEPTED'}
  $ExpectedBlob=$approved
  Set-Content -LiteralPath (Join-Path $origin 'windows\local-watchdog.ps1') -Value 'new unrelated fake source' -Encoding ASCII
  & git -C $origin add -- windows/local-watchdog.ps1
  & git -C $origin commit -q -m 'synthetic changed main'
  if($LASTEXITCODE -ne 0){throw 'GIT_FIXTURE_SECOND_COMMIT_FAILED'}
  $held=$false
  try{Assert-ApprovedMainBlob}catch{if($_.Exception.Message -match 'GIT_MAIN_PROOF_COMMIT_MISMATCH'){$held=$true}else{throw}}
  if(-not $held){throw 'STALE_MAIN_COMMIT_WAS_ACCEPTED'}
  $leftovers=@(Get-ChildItem -LiteralPath $stage -Force)
  if($leftovers.Count -ne 0){throw 'TEMPORARY_GIT_PROOF_NOT_CLEANED'}
  Write-Host 'SC013_GIT_MAIN_BLOB_FIXTURE_PASS=True'
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
