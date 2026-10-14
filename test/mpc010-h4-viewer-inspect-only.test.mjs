import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('../.github/scripts/mpc010-h4-viewer-owner-release.ps1', import.meta.url),'utf8');
const sot=readFileSync(new URL('../SOURCE_OF_TRUTH.md',import.meta.url),'utf8');
test('H4 viewer source checker defaults to field HOLD',()=>{
  assert.match(script,/ValidateSet\('SelfTest','Inspect','Stage','Apply','Rollback'\)/);
  assert.match(script,/if\(\$Mode -in @\('Stage','Apply','Rollback'\)\) \{\s*throw 'MPC010_FIELD_RELEASE_NOT_YET_IMPLEMENTED_OR_AUTHORIZED'\s*\}/);
  assert.ok(script.indexOf("if($Mode -in @('Stage','Apply','Rollback'))")<
            script.indexOf('VerifyCandidate $work'));
  assert.match(script,/Write-Output 'FIELD_APPLY_AUTHORIZED=False'/);
  assert.doesNotMatch(script,/Start-Process|Stop-Process|Set-Content|Copy-Item|Remove-Item|New-Item|Move-Item|Invoke-RestMethod/);
});
test('field inspection pins H4 identity STOP localhost and 12 reviewed SHA',()=>{
  for(const frag of ['DESKTOP-H4A16IL','DESKTOP-H4A16IL\\admin',
    'D:\\MAGASIN_ROBOTS\\control-center','AUTOSTART_DISABLED',
    "export const REVIEWED_CANDIDATE_SHA256_20261014",
    "function VerifyCandidate","CANDIDATE_CONTENT_HASH_DRIFT",
    "UNEXPECTED_LOCAL_VIEWER_LISTENER","BUSINESS_WORKER_PRESENT"]){
    assert.ok(script.includes(frag),frag);
  }
  assert.match(script,/\$expectedFiles=\[ordered\]@\{/);
  assert.match(script,/function AssertNoReparse/);
});
test('no SOT section grants H4 installation from this source-only PR',()=>{
  assert.match(sot,/MPC-010 H4 VIEWER FIELD RELEASE APPROVAL GATE \(PROPOSED, INSPECT ONLY/);
  assert.match(sot,/not live release authorization/i);
  assert.match(sot,/Stage, Apply and Rollback deliberately throw/i);
});
