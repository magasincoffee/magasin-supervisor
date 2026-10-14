import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const text = readFileSync(new URL('../SOURCE_OF_TRUTH.md',import.meta.url),'utf8');
const anchor='### MPC-010 separate H4 Control Center VIEWER-ONLY release request and FIELD HOLD';
const section=text.split(anchor)[1];
test('exactly one H4 viewer-only exception request; not qualified for H4 stage or apply',()=>{
  assert.equal(text.split(anchor).length,2);
  assert.ok(section);
  for(const mark of [
    'H4 NOT INSTALLED','MPC-009 remains BLOCKED','UNKNOWN_NOT_OBSERVED',
    'hard field release HOLD','UNKNOWN is HOLD',
    'No stage, backup mutation, process stop or file apply',
    'STOP/AUTOSTART_DISABLED','DESKTOP-H4A16IL','four exact-head hosted CI',
    'independent final-head Codex review'
  ]) assert.ok(section.includes(mark),mark);
  assert.doesNotMatch(section,/FIELD_APPLY_APPROVED=True|H4_APPLIED_GREEN|OWNER_START_APPROVED=True/);
});
test('Owner request cannot itself authorize production, worker dispatch or credentials',()=>{
  const phrases=['NOT starting Supervisor','NOT enabling MPC-009 task dispatch',
    'NOT touching live SQLite or outbound state',
    'NOT provisioning credentials','not authorization to bypass any failed gate'];
  for(const mark of phrases)assert.ok(section.includes(mark),mark);
});
