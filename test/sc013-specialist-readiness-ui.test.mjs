import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const server = new URL("../src/control-center/server.py",import.meta.url);
const client = new URL("../src/control-center/web/app.js",import.meta.url);
const diag = new URL("../src/control-center/specialist_readiness.py",import.meta.url);

test("SAYDI and SAPO status API only adds read-only reasons, no new mutating route", async () => {
  const code=await fs.readFile(server,"utf8");
  assert.match(code,/if robot_id in \("saydi", "sapo"\):/);
  assert.match(code,/specialist_readiness\.examine\(/);
  assert.match(code,/robot\["controls_ready"\] = False/);
  assert.match(code,/specialist_enabled=flags\.get\(robot_id\)/);
  assert.match(code,/free_ram_gb=psutil\.virtual_memory\(\)\.available \/ 1073741824/);
  assert.match(code,/route not in \("\/api\/supervisor\/control","\/api\/coordinator\/control"\)/);
  assert.doesNotMatch(code,/["']\/api\/(?:saydi|sapo)\/control["']/);
});
test("UI reports specific reasons instead of a silent disabled button", async () => {
  const code=await fs.readFile(client,"utf8");
  assert.match(code,/specialistBlockers\(r\)/);
  assert.match(code,/Vì sao chưa thể bật \/ tắt\?/);
  assert.match(code,/THIẾU_RAM_CHO_SAYDI/);
  assert.match(code,/SAPO_CÓ_LỊCH_ĐỒNG_BỘ_CŨ_CHƯA_CHUYỂN_SANG_OWNER_CONTROL/);
  assert.match(code,/esc\(explainBlocker\(x\)\)/);
  assert.match(code,/esc\(r\.control\?\.recovery_hint/);
  assert.match(code,/r\.id==="supervisor"\|\|r\.id==="coordinator"/);
  assert.doesNotMatch(code,/START_SAYDI|START_SAPO|\/api\/(?:saydi|sapo)\/control/);
});
test("readiness module cannot start a worker or grant business execution", async () => {
  const code=await fs.readFile(diag,"utf8");
  for(const name of ["start_allowed","stop_allowed","control_ready","business_dispatch_authorized","owner_authority_verified"]){
    assert.match(code,new RegExp('"'+name+'": False'));
  }
  assert.doesNotMatch(code,/subprocess|Start-ScheduledTask|Stop-ScheduledTask|os\.system|Popen|urlopen|request\.post|powershell\.exe/);
});
