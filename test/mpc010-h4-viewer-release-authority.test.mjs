import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const authority = readFileSync(new URL('../SOURCE_OF_TRUTH.md',import.meta.url),'utf8');
const anchor='### MPC-010 separate H4 Control Center VIEWER-ONLY release request and FIELD HOLD';

const required=[
  'H4 NOT INSTALLED','MPC-009 remains BLOCKED','UNKNOWN_NOT_OBSERVED',
  'hard field release HOLD','UNKNOWN is HOLD',
  'No stage, backup mutation, process stop or file apply',
  'STOP/AUTOSTART_DISABLED','DESKTOP-H4A16IL','four exact-head hosted CI',
  'independent final-head Codex review','NOT starting Supervisor','NOT removing STOP/AUTOSTART_DISABLED',
  'NOT enabling MPC-009 task dispatch','NOT touching live SQLite or outbound state',
  'NOT provisioning credentials','NOT switching SOT/project',
  'not authorization to bypass any failed gate'
];

const forbidden=[
  // Reject grant language regardless of English gerund/noun ordering. Treat all
  // authorizing claims within this narrowly scoped viewer section as unsafe.
  /\b(?:SWITCHING|STARTING|DISPATCHING|PROVISIONING|ENABLING|DEPLOYING|APPLYING|REMOVING|CLEARING)\b[^\n.]{0,100}\b(?:IS|ARE|WAS|WERE)\s+(?:APPROVED|AUTHORIZED|ALLOWED|ENABLED)\b/i,
  /\b(?:REMOV(?:E|ING)|CLEAR(?:ING)?|DISABL(?:E|ING))\s+(?:THE\s+)?(?:STOP|AUTOSTART_DISABLED)(?:\/AUTOSTART_DISABLED)?\s+(?:IS\s+|ARE\s+)?(?:APPROVED|AUTHORIZED|ALLOWED|ENABLED)\b/i,
  /\b(?:STOP|AUTOSTART_DISABLED)\s+(?:LATCH\s+)?(?:REMOVAL|CLEARING|DISABLEMENT)\s+(?:IS\s+|WAS\s+)?(?:APPROVED|AUTHORIZED|ALLOWED|ENABLED)\b/i,
  /\b(?:STOP|AUTOSTART_DISABLED)\s+(?:AND\s+(?:STOP|AUTOSTART_DISABLED)\s+)?(?:MAY|CAN)\s+BE\s+(?:REMOVED|CLEARED|DISABLED)\b/i,
  /\b(?:H4\s+)?(?:FIELD\s+)?APPLY\s+(?:IS\s+|WAS\s+)?(?:APPROVED|AUTHORIZED|ENABLED)\b/i,
  /\b(?:H4\s+)?(?:FIELD\s+)?(?:INSTALL|DEPLOY)\s+(?:IS\s+|WAS\s+)?(?:APPROVED|AUTHORIZED|ENABLED)\b/i,
  /\bMPC-009(?:\s+(?:TASK|BUSINESS))?\s+DISPATCH\s+(?:IS\s+|WAS\s+)?(?:APPROVED|AUTHORIZED|ENABLED)\b/i,
  /\b(?:CREDENTIALS?|OWNER\s+AUTH)\s+(?:ARE\s+|IS\s+|WERE\s+)?(?:APPROVED|AUTHORIZED|ENABLED)\b/i,
  /\b(?:SOT|PROJECT)\s+SWITCH\s+(?:IS\s+|WAS\s+)?(?:APPROVED|AUTHORIZED|ENABLED)\b/i,
  /\b(?:OWNER\s+)?(?:WORKER\s+)?START\s+(?:IS\s+|WAS\s+)?(?:APPROVED|AUTHORIZED|ENABLED)\b/i,
  /\b(?:START|DISPATCH|APPLY)_APPROVED\s*=\s*(?:TRUE|1)\b/i,
  /\b(?:H4_APPLIED_GREEN|FIELD_APPLY_APPROVED|OWNER_START_APPROVED)\b/i,
];

function viewerSection(source){
  assert.equal(source.split(anchor).length,2,'exactly one viewer-specific SOT heading');
  // Stop at the NEXT heading: no future unrelated SOT task may satisfy this gate.
  return source.split(anchor)[1].split(/\r?\n(?=###\s)/)[0];
}
function assertViewerAuthority(source){
  const section=viewerSection(source);
  for(const mark of required) assert.ok(section.includes(mark),'missing viewer SOT boundary: '+mark);
  for(const pattern of forbidden) assert.doesNotMatch(section,pattern,'forbidden grant: '+pattern);
}
test('MPC-010 H4 viewer field HOLD is fully scoped and cannot grant START or APPLY',()=>{
  assertViewerAuthority(authority);
});
test('later unrelated sections cannot satisfy missing viewer authority',()=>{
  const section=viewerSection(authority);
  for(const mark of required){
    const candidate=authority.replace(anchor+section,anchor+section.split(mark).join('REMOVED_BOUNDARY'));
    assert.throws(()=>assertViewerAuthority(candidate+'\n### unrelated later task\n'+mark),
      /missing viewer SOT boundary/,mark);
  }
});
test('explicit H4 apply, task dispatch, credentials, START or switch grants all fail closed',()=>{
  for(const phrase of [
    'H4 APPLY is approved','H4 DEPLOY is authorized','MPC-009 dispatch is approved',
    'credentials are approved','Owner auth is enabled','SOT switch is approved',
    'project switch is authorized','Owner START is approved',
    'Removing STOP/AUTOSTART_DISABLED is authorized',
    'STOP removal is approved','AUTOSTART_DISABLED may be cleared',
    'Switching SOT/project is authorized','Starting Supervisor is approved',
    'Dispatching MPC-009 tasks is approved','Provisioning Owner credentials is authorized',
    'Enabling business workers is allowed','Deploying H4 viewer is approved',
    'FIELD_APPLY_APPROVED=True','H4_APPLIED_GREEN'
  ]){
    const candidate=authority.replace(anchor,anchor+'\n'+phrase+'\n');
    assert.throws(()=>assertViewerAuthority(candidate),/forbidden grant/,phrase);
  }
});
