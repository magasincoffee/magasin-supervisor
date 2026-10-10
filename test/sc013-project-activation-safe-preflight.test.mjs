import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const server=new URL("../src/control-center/server.py",import.meta.url);
const ui=new URL("../src/control-center/web/app.js",import.meta.url);
const verifier=new URL("../src/control-center/supervisor_project_activation.py",import.meta.url);
const links=new URL("../src/control-center/supervisor_project_links.py",import.meta.url);

test("Supervisor project activation preflight has only an Owner-authenticated read-only check",async()=>{
 const s=await fs.readFile(server,"utf8");
 assert.match(s,/if route == "\/api\/supervisor\/project\/check":/);
 assert.match(s,/candidate\["confirm"\] != "CHECK_SUPERVISOR_SOT_ONLY"/);
 assert.match(s,/supervisor_project_activation\.inspect_candidate\(candidate\["id"\]\)/);
 assert.match(s,/hmac\.compare_digest\(self\.headers\.get\("X-MAGASIN-CSRF"/);
 assert.match(s,/origin != "http:\/\/" \+ host/);
 assert.match(s,/return self\.send_data\(json\.dumps\(result,ensure_ascii=False\)/);
 assert.doesNotMatch(s,/\/api\/supervisor\/project\/activate|\/api\/supervisor\/project\/switch/);
});
test("UI maps per pending project to source validation without enabling worker",async()=>{
 const s=await fs.readFile(ui,"utf8");
 assert.match(s,/data-sot-check/);
 assert.match(s,/Kiểm tra trước kích hoạt/);
 assert.match(s,/CHECK_SUPERVISOR_SOT_ONLY/);
 assert.match(s,/\/api\/supervisor\/project\/check/);
 assert.match(s,/project_switch_allowed/);
 assert.match(s,/SOT đã đối chiếu GitHub blob/);
 assert.match(s,/Owner START/);
 assert.doesNotMatch(s,/data-project-switch|\/api\/supervisor\/project\/activate|START_SUPERVISOR_PROJECT/);
});
test("source verifier GET is pinned and never promotes task/source check to authority",async()=>{
 const s=await fs.readFile(verifier,"utf8");
 assert.match(s,/GITHUB_SOT_CHANGED_DURING_VERIFICATION/);
 assert.match(s,/class _NoRedirect\(HTTPRedirectHandler\)/);
 assert.match(s,/method="GET"/);
 assert.match(s,/BLOCKED_NOT_QUALIFIED/);
 assert.match(s,/project_switch_allowed": False/);
 assert.match(s,/business_dispatch_authorized": False/);
 assert.match(s,/SOT_NEXT_TASK_REQUIRES_AUTHORITATIVE_RESYNC/);
 assert.match(s,/SUPERVISOR_OUTBOUND_UNKNOWN_OUTCOME_NO_REPLAY/);
 assert.doesNotMatch(s,/subprocess|Popen|os\.replace|write_bytes|write_text/);
 const prev=await fs.readFile(links,"utf8");
 assert.match(prev,/PENDING_SOT_REVIEW/);
 assert.match(prev,/SAVE_SUPERVISOR_SOT_LINK_ONLY/);
});
