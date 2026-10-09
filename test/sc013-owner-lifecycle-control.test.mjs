import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const apiPath=new URL('../src/control-center/server.py',import.meta.url);
const uiPath=new URL('../src/control-center/web/app.js',import.meta.url);
const lifecyclePath=new URL('../src/coordinator/owner_lifecycle.py',import.meta.url);
const sotPath=new URL('../SOURCE_OF_TRUTH.md',import.meta.url);

test('local Control Center enforces its existing host, origin, CSRF and exact commands',async()=>{
  const s=await fs.readFile(apiPath,'utf8');
  for(const marker of [
    '127.0.0.1','Host','Origin','X-MAGASIN-CSRF','hmac.compare_digest',
    'Sec-Fetch-Site','/api/coordinator/control','/api/supervisor/control',
    'START_COORDINATOR_READ_ONLY','STOP_COORDINATOR',
    'START_SUPERVISOR','STOP_SUPERVISOR',
    'owner_lifecycle.perform(','source="local_control_center"',
  ])assert.ok(s.includes(marker),marker);
  assert.match(s,/set\(value\) != \{"action","confirm"\}/);
  assert.match(s,/route not in \("\/api\/supervisor\/control","\/api\/coordinator\/control"\)/);
  assert.match(s,/from http\.server import BaseHTTPRequestHandler, ThreadingHTTPServer/);
  assert.match(s,/robot\["controls_ready"\] = bool\(robot\["control"\]\.get\("control_ready"\)\)/);
});
test('Owner read-only START and STOP are visually separate from Supervisor lifecycle',async()=>{
  const s=await fs.readFile(uiPath,'utf8');
  assert.match(s,/robot==="coordinator"\?"\/api\/coordinator\/control":"\/api\/supervisor\/control"/);
  assert.match(s,/START_COORDINATOR_READ_ONLY/);
  assert.match(s,/STOP_COORDINATOR/);
  assert.match(s,/START_SUPERVISOR/);
  assert.match(s,/STOP_SUPERVISOR/);
  assert.match(s,/giám sát SOT/i);
  assert.match(s,/Business Executor/);
  assert.match(s,/confirm\(warning\)/);
  assert.match(s,/"X-MAGASIN-CSRF":latest\.csrf/);
  assert.doesNotMatch(s,/\b(?:localStorage|sessionStorage)\b/);
});
test('lifecycle module cannot start daemon, Chrome, specialist or grant business execution',async()=>{
  const s=await fs.readFile(lifecyclePath,'utf8');
  assert.match(s,/MIN_AVAILABLE_RAM_GIB = 0\.75/);
  assert.match(s,/MAX_HEARTBEAT_AGE_SECONDS = 75 \* 60/);
  assert.match(s,/O_EXCL/);
  assert.match(s,/os\.replace\(tmp, path\)/);
  assert.match(s,/LIFECYCLE_LOCK_PRESENT/);
  assert.match(s,/MONITORING_READ_ONLY/);
  assert.match(s,/ARMED_READ_ONLY/);
  assert.match(s,/business_dispatch_enabled": False/);
  assert.match(s,/execution_enabled": False/);
  assert.match(s,/specialists_started": False/);
  assert.doesNotMatch(s,/^\s*(?:from|import) subprocess\b/m);
  assert.doesNotMatch(s,/os\.system\(|subprocess\.|Popen\(|Start-Process|Start-ScheduledTask/);
  assert.doesNotMatch(s,/SUPERVISOR\s*\/\s*["']STOP["'].*unlink/);
});
test('SOT separately authorizes only read-only monitoring, not Business Executor',async()=>{
  const s=await fs.readFile(sotPath,'utf8');
  assert.match(s,/### SC-013 Owner Coordinator READ_ONLY lifecycle \(approved 2026-10-09\)/);
  assert.match(s,/START_COORDINATOR_READ_ONLY/);
  assert.match(s,/Business Executor.*NOT_QUALIFIED/);
  assert.match(s,/Owner STOP/);
  assert.match(s,/do not enable specialists/i);
});
