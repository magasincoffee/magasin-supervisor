const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const wf=fs.readFileSync('.github/workflows/saydi-v6-python-readonly.yml','utf8');
const ps=fs.readFileSync('.github/scripts/saydi-v6-python-readonly.ps1','utf8');
test('owner-only one-file gate and actual H4 runner',()=>{
  for(const v of ['verify-request:',"github.actor == 'magasincoffee'",
    'ONLY_ONE_PYTHON_CHECK_REQUEST_FILE','CHECK_REQUEST_NOT_ALLOWLISTED',
    'magasin-h4a16il','DESKTOP-H4A16IL','persist-credentials: false']){
    assert.ok(wf.includes(v),v);
  }
  for(const v of ['workflow_dispatch:','  schedule:','  pull_request:','  issues:']){
    assert.ok(!wf.includes(v),v);
  }
});
test('H4 preflight never launches Python or writes to Windows',()=>{
  for(const v of ['Get-Item','Python312','NO_FILE_OR_ACL_CHANGES=True',
    'PYTHON_EXECUTION_NOT_ATTEMPTED=True','WRONG_H4_HOST']){
    assert.ok(ps.includes(v),v);
  }
  for(const v of ['New-Item','Copy-Item','Move-Item','Remove-Item',
    'Set-Content','Set-Acl','Start-Process','Start-Service',
    'Stop-Service','icacls.exe','Invoke-WebRequest','Expand-Archive',
    '& $python','-m venv','pip install','Set-ExecutionPolicy']){
    assert.ok(!ps.includes(v),v);
  }
});
