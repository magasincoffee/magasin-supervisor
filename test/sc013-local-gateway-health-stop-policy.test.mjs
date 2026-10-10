import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const patch=new URL("../src/coordinator/local_gateway_health_patch.py",import.meta.url);
const sot=new URL("../SOURCE_OF_TRUTH.md",import.meta.url);

test("Gateway source patch is strictly health_check only and never changes Owner STOP",async()=>{
 const s=await fs.readFile(patch,"utf8");
 assert.match(s,/TARGET_SHA256 = "64d2758fdfbfaa468937f4b91bbe1909103db9a427587bd93854bc1d79f00ba1"/);
 assert.match(s,/OLD_HEALTH/);
 assert.match(s,/NEW_HEALTH/);
 assert.match(s,/OLD_DISPATCH/);
 assert.match(s,/NEW_DISPATCH/);
 assert.match(s,/WHERE action='health_check' AND status='WAIT_OWNER_STOP'/);
 assert.match(s,/AND local_job_id IS NULL/);
 assert.match(s,/AND action='health_check' ORDER BY received_at/);
 assert.match(s,/GATEWAY_NONHEALTH_AUTHORITY_MISSING/);
 assert.match(s,/ast\.parse\(patched/);
 assert.match(s,/hashlib\.sha256\(source\)/);
 assert.doesNotMatch(s,/subprocess|Popen|os\.system|os\.replace|Start-Process|Stop-Process|Start-ScheduledTask|Stop-ScheduledTask|write_bytes|write_text/);
});
test("Local health gateway rollout is not a Supervisor START or executable dispatch approval",async()=>{
 const s=await fs.readFile(sot,"utf8");
 assert.match(s,/Local Gateway read-only health under STOP/);
 assert.match(s,/Issue #381/);
 assert.match(s,/WAIT_OWNER_STOP/);
 assert.match(s,/health_check/);
 assert.match(s,/WAIT_SOT_AUTHORITY/);
 assert.match(s,/exact original gateway SHA-256/);
 assert.match(s,/SC-013 IN PROGRESS/);
});
