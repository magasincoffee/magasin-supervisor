const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const wf=fs.readFileSync('.github/workflows/saydi-v6-python-readonly.yml','utf8');
const ps=fs.readFileSync('.github/scripts/saydi-v6-python-readonly.ps1','utf8');
test('owner-only one-file gate and actual H4 runner',()=>{
  for(const v of ['verify-request:',"github.actor == 'magasincoffee'",
    'ONLY_ONE_PYTHON_CHECK_REQUEST_FILE','CHECK_REQUEST_NOT_ALLOWLISTED',
    'magasin-h4a16il','DESKTOP-H4A16IL','persist-credentials: false',
    'PRIOR_MAIN_CI_NOT_GREEN', 'body.base_main_sha!==before',
    'REQUEST_BOUND_TO_UNIQUE_BASE_SHA=True']){
    assert.ok(wf.includes(v),v);
  }
  for(const v of ['workflow_dispatch:','  schedule:','  pull_request:','  issues:']){
    assert.ok(!wf.includes(v),v);
  }
});
test('H4 preflight never launches Python or writes to Windows',()=>{
  for(const v of ['Get-Item','Get-Command','RUNNER_TOOL_CACHE',
    'HKLM:', 'SHARED_PYTHON_METADATA_COUNT=',
    'TOOLCACHE_PYTHON_METADATA_COUNT=',
    'NO_FILE_OR_ACL_CHANGES=True', 'CANDIDATE_PYTHON_EXECUTED=False',
    'WRONG_H4_HOST']){
    assert.ok(ps.includes(v),v);
  }
  for(const v of ['New-Item','Copy-Item','Move-Item','Remove-Item',
    'Set-Content','Set-Acl','Start-Process','Start-Service',
    'Stop-Service','icacls.exe','Invoke-WebRequest','Expand-Archive',
    'C:\\Program Files\\Python312', 'D:\\SAYDI_V6\\python',
    '& $python','-m venv','pip install','Set-ExecutionPolicy']){
    assert.ok(!ps.includes(v),v);
  }
});
