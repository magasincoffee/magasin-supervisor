import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {renderOwnerRequestPanel,selectedRequestTarget} from "../src/control-center/web/project_request_view.mjs";
import {renderProjectTree} from "../src/control-center/web/project_tree_view.mjs";

const selected="supervisor/project-control/MPC-006";
const catalogue={
 status:"LOCAL_UNVERIFIED",readOnly:true,projects:[{
 id:"supervisor",title:"Robot Supervisor",scopeStatus:"UNKNOWN",
 features:[{id:"project-control",title:"MAGASIN PROJECT CONTROL",scopeStatus:"UNKNOWN",
 tasks:[{id:"MPC-006",title:"Gửi đề xuất chỉnh sửa",scopeStatus:"UNKNOWN"}]}]}]
};
const render=(session,draft={})=>renderOwnerRequestPanel({catalogue,selected,session,draft});

test("Only exact listed selected task gets request form",()=>{
 assert.equal(selectedRequestTarget(catalogue,selected)?.key,selected);
 for(const bad of ["", "supervisor", "supervisor/project-control",
  "supervisor/project-control/MPC-007", "print-ops/project-control/MPC-006",
  "supervisor/project-control/../../evil", "<script>"]){
  assert.equal(selectedRequestTarget(catalogue,bad),null);
  assert.doesNotMatch(renderOwnerRequestPanel({catalogue,selected:bad,session:{authenticated:true,login_enabled:true}}),/id="mpc-owner-request-form"/);
 }
});

test("Fails closed and never shows writable form before verified Owner session",()=>{
 const unconfigured=render(null);
 assert.match(unconfigured,/Chưa cấu hình phiên đăng nhập Owner/);
 assert.doesNotMatch(unconfigured,/id="mpc-owner-request-form"/);
 const unauthenticated=render({login_enabled:true,authenticated:false});
 assert.match(unauthenticated,/id="mpc-owner-login-form"/);
 assert.match(unauthenticated,/type="password"/);
 assert.doesNotMatch(unauthenticated,/id="mpc-owner-request-form"/);
 const locked=render({login_enabled:false,authenticated:true});
 assert.doesNotMatch(locked,/id="mpc-owner-request-form"/);
});

test("Owner form supports Vietnamese task-specific text, priority, bounded screenshot URLs",()=>{
 const html=render({login_enabled:true,authenticated:true},{
  description:"Đổi nút <img src=x onerror=alert(1)> theo yêu cầu",
  screenshots:"https://github.com/user-attachments/assets/70d27727-118a-4246-ac55-237479747f91",
  priority:"HIGH"
 });
 assert.match(html,/id="mpc-owner-request-form"/);
 assert.match(html,/data-target="supervisor\/project-control\/MPC-006"/);
 assert.match(html,/id="mpc-owner-description"/);
 assert.match(html,/selected>Cao/);
 assert.match(html,/id="mpc-owner-screenshots"/);
 assert.match(html,/tối đa 3/);
 assert.match(html,/&lt;img/);
 assert.doesNotMatch(html,/<img src=x/);
 assert.doesNotMatch(html,/data-owner-start|data-owner-stop|action="\/api\/owner/);
});

test("Receipt reports pending Owner review only, not approved or running",()=>{
 const html=renderOwnerRequestPanel({catalogue,selected,session:{login_enabled:true,authenticated:true},
  receipt:{request_id:"abc123",status:"PENDING_OWNER_REVIEW",dispatch_authorized:false}});
 assert.match(html,/Chờ Owner xem xét/);
 assert.doesNotMatch(html,/Đã phê duyệt|Đang thực thi|VERIFIED_DONE/);
 const tree=renderProjectTree({catalogue,selected,expanded:["supervisor","supervisor/project-control"],
  ownerRequest:{session:{login_enabled:true,authenticated:true}}});
 assert.match(tree,/id="mpc-owner-request-form"/);
 assert.match(tree,/Chưa xác minh/);
});

test("Browser uses scoped cookie, two independent CSRF headers and stable retry key",async()=>{
 const app=await fs.readFile(new URL("../src/control-center/web/app.js",import.meta.url),"utf8");
 const server=await fs.readFile(new URL("../src/control-center/server.py",import.meta.url),"utf8");
 assert.match(app,/credentials:"same-origin"/);
 assert.match(app,/X-MPC-CSRF/);
 assert.match(app,/X-MAGASIN-CSRF/);
 assert.match(app,/crypto\.randomUUID\(\)/);
 assert.match(app,/unchanged\?former\.idempotency_key/);
 assert.match(server,/OWNER_SESSIONS\.check/);
 assert.match(server,/HttpOnly; SameSite=Strict; Path=\/api\/owner/);
 assert.match(server,/OWNER_SESSIONS\.enabled/);
 assert.match(server,/mpc_owner\.configured_store/);
 assert.match(server,/mpc_owner\.submit_request/);
 assert.doesNotMatch(server,/route\s*==\s*"\/api\/projects\/activate"|route\s*==\s*"\/api\/owner\/dispatch"/);
 assert.match(server,/\/project_request_view\.mjs/);
});
