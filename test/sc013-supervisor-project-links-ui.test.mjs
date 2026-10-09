import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const server=new URL("../src/control-center/server.py",import.meta.url);
const ui=new URL("../src/control-center/web/app.js",import.meta.url);
const api=new URL("../src/control-center/supervisor_project_links.py",import.meta.url);

test("Supervisor project link UI shows current SOT/repo and a pending-only URL form",async()=>{
  const s=await fs.readFile(ui,"utf8");
  for(const text of [
    "const supervisorProjectPanel=",
    "Dự án Supervisor quản lý",
    "Source of Truth hiện tại",
    "Repository dự án đang gắn",
    "Gắn Source of Truth cho một dự án khác",
    "Lưu liên kết để xác minh",
    "Chờ xác minh SOT / Chưa kích hoạt",
    "Không đổi dự án đang chạy",
    "supervisorProjectPanel(r)",
    "/api/supervisor/project/link",
    "SAVE_SUPERVISOR_SOT_LINK_ONLY",
  ])assert.ok(s.includes(text),text);
  assert.match(s,/esc\(supervisorSotDraft\)/);
  assert.match(s,/esc\(active\.sot_url\)/);
  assert.match(s,/r\.id!=="supervisor"/);
  assert.match(s,/supervisorSotDraft=e\.target\.value/);
  assert.doesNotMatch(s,/window\.open\(|startSupervisorFromLink|exec\(.*sot_url/);
});
test("CSRF+same-origin preflight occurs before pending-link write, no arbitrary execution",async()=>{
  const s=await fs.readFile(server,"utf8");
  assert.match(s,/if route == "\/api\/supervisor\/project\/link":/);
  assert.match(s,/import supervisor_project_links/);
  assert.match(s,/supervisor_project_links\.save_request\(/);
  assert.match(s,/proposal\["sot_url"\], proposal\["confirm"\]/);
  assert.match(s,/set\(proposal\) != \{"sot_url", "confirm"\}/);
  assert.match(s,/hmac\.compare_digest\(self\.headers\.get\("X-MAGASIN-CSRF"/);
  assert.match(s,/origin != "http:\/\/" \+ host/);
  assert.match(s,/route not in \("\/api\/supervisor\/control","\/api\/coordinator\/control"\)/);
  assert.doesNotMatch(s,/\/api\/(?:saydi|sapo)\/control/);
});
test("project link registry never modifies single-conversation-control.json or authorizes work",async()=>{
  const s=await fs.readFile(api,"utf8");
  assert.match(s,/source_of_truth_url/);
  assert.match(s,/SINGLE_CONVERSATION_V1/);
  assert.match(s,/PENDING_SOT_REVIEW/);
  assert.match(s,/new_link_activates_project": False/);
  assert.match(s,/business_dispatch_authorized": False/);
  assert.match(s,/OWNER_STOP_OR_BINDING_UNVERIFIED/);
  assert.match(s,/os\.replace\(temp_path, requests\)/);
  assert.doesNotMatch(s,/os\.replace\(temp_path,\s*current\)|start_process|subprocess|urllib\.request/);
});
