import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CONTROL_CENTER_BUNDLE,H4_OBSERVED_20261014,evaluateMpc010ReleaseMetadata}
  from '../src/control-center/mpc010_control_center_preflight.mjs';

const syntheticSha='a'.repeat(40),syntheticHash='b'.repeat(64);
const baseline=()=>({
  hostname:'DESKTOP-H4A16IL', ownerIdentity:'DESKTOP-H4A16IL\\admin',
  expectedMainSha:syntheticSha,liveMainSha:syntheticSha,candidateMainSha:syntheticSha,
  ownerStopPresent:true,autostartDisabledPresent:true,
  wrapperProcessCount:0,businessWorkerProcessCount:0,ambiguousOutboundAbsent:true,
  reparsePathsAbsent:true,symlinksAbsent:true,freeDGiB:56,
  installedHashes:{...H4_OBSERVED_20261014},
  candidateHashes:Object.fromEntries(CONTROL_CENTER_BUNDLE.map(p=>[p,syntheticHash])),
  localPortListeners:[],ownerCredentialConfigured:false,
  rollbackPlan:'ISOLATED_D_HASH_VERIFIED_NOT_EXECUTED',
  telemetryReadOnly:true,noSotOrIssueWrites:true,
});

test('matched synthetic metadata never authorizes deployment, START or Owner approval',()=>{
  const r=evaluateMpc010ReleaseMetadata(baseline());
  assert.equal(r.state,'SYNTHETIC_METADATA_CONSISTENT_ONLY');
  assert.deepEqual(r.holds,[]);
  for(const key of ['fieldApplyAuthorized','stageAuthorized','workerStartAuthorized','productionAccepted','ownerApprovalEstablished'])
    assert.equal(r[key],false);
});

test('missing or malformed evidence fails closed',()=>{
  for(const v of [null,{},[],undefined]){
    const r=evaluateMpc010ReleaseMetadata(v);
    assert.equal(r.state,'HOLD'); assert.equal(r.fieldApplyAuthorized,false);
  }
});

test('wrong computer, Owner, SHA or changed installed runtime blocks release',()=>{
  const mods=[
    {hostname:'DESKTOP-4K7IM13'}, {ownerIdentity:'NETWORK SERVICE'},
    {liveMainSha:'f'.repeat(40)}, {candidateMainSha:'f'.repeat(40)},
    {expectedMainSha:'not-a-sha'},
    {installedHashes:{...H4_OBSERVED_20261014,'server.py':'f'.repeat(64)}},
  ];
  for(const patch of mods)
    assert.equal(evaluateMpc010ReleaseMetadata({...baseline(),...patch}).state,'HOLD',JSON.stringify(patch));
});

test('STOP removal, wrapper and uncertain transactions fail closed',()=>{
  for(const patch of [{ownerStopPresent:false},{autostartDisabledPresent:false},
    {wrapperProcessCount:1},{businessWorkerProcessCount:1},{ambiguousOutboundAbsent:false},
    {symlinksAbsent:false},{reparsePathsAbsent:false}]){
    const r=evaluateMpc010ReleaseMetadata({...baseline(),...patch});
    assert.equal(r.state,'HOLD',JSON.stringify(patch)); assert.equal(r.workerStartAuthorized,false);
  }
});

test('missing UI module, digest, rollback, disk and port identity block release',()=>{
  const missing={...baseline().candidateHashes};
  delete missing['src/control-center/web/project_supervisor_telemetry.mjs'];
  const bad={...baseline().candidateHashes,'src/control-center/web/app.js':'NOT_A_DIGEST'};
  const mods=[
    {candidateHashes:missing},{candidateHashes:bad},{candidateHashes:{}},
    {freeDGiB:0.5},{rollbackPlan:'NOT_PREPARED'},{ownerCredentialConfigured:null},
    {localPortListeners:[{bind:'0.0.0.0:8781',pid:1,exactServerPath:'D:\\MAGASIN_ROBOTS\\control-center\\server.py'}]},
    {localPortListeners:[{bind:'127.0.0.1:8781',pid:9,exactServerPath:'C:\\wrong.py'}]},
    {localPortListeners:[{bind:'127.0.0.1:8781',pid:9,exactServerPath:'D:\\MAGASIN_ROBOTS\\control-center\\server.py'},{bind:'127.0.0.1:8781',pid:10,exactServerPath:'D:\\MAGASIN_ROBOTS\\control-center\\server.py'}]},
    {telemetryReadOnly:false},{noSotOrIssueWrites:false},
  ];
  for(const patch of mods)
    assert.equal(evaluateMpc010ReleaseMetadata({...baseline(),...patch}).state,'HOLD',JSON.stringify(patch));
});

test('module has no host IO or subprocess capability and includes full browser module bundle',()=>{
  const s=readFileSync(new URL('../src/control-center/mpc010_control_center_preflight.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(s,/from\s+['"]node:(?:fs|child_process|net|http|https)/);
  assert.doesNotMatch(s,/\b(?:exec|spawn|fetch|unlink|writeFile|Start-Process|Remove-Item)\s*\(/);
  for(const file of ['project_tree_view.mjs','project_detail_view.mjs',
    'project_request_view.mjs','project_supervisor_telemetry.mjs'])
    assert.ok(CONTROL_CENTER_BUNDLE.some(p=>p.endsWith('/'+file)),file);
});
