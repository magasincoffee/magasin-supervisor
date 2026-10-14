import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {projectSupervisorTelemetryProjection,renderProjectSupervisorTelemetry} from "../src/control-center/web/project_supervisor_telemetry.mjs";
import {renderProjectTree} from "../src/control-center/web/project_tree_view.mjs";

const iso="2026-10-14T09:30:00Z";
const now=Date.parse("2026-10-14T09:40:00Z");
const sot="https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md";
const good=()=>({
 id:"supervisor",status:"running",phase:"EXECUTING",last_seen:iso,
 processes:[{pid:111}],details:{"Owner STOP":true,"Trạng thái điều khiển":"RUNNING"},
 mpc_readonly_latches:{schema:"MPC-008_LOCAL_LATCHES_V1",host_verified:true,
  owner_stop_marker:true,autostart_disabled_marker:true},
 project_links:{read_only:true,worker_start_allowed:false,business_dispatch_authorized:false,
  blockers:[],status:"OWNER_STOP_SAFE_TO_SAVE_LINK_REQUEST_ONLY",
  active:{sot_url:sot,execution_authorized:false},
  requests:[{status:"PENDING_SOT_REVIEW",execution_authorized:false}]},
 active_task:{task_id:"MPC-008",state:"RUNNING",approved:true}
});
const read=path=>readFile(new URL("../"+path,import.meta.url),"utf8");

test("unknown host, no data or forged running robot never asserts working",()=>{
 for(const value of [null,{}, {id:"gateway",status:"running"}, {id:"supervisor",status:"running"}]){
  const p=projectSupervisorTelemetryProjection(value,{nowMs:now});
  assert.equal(p.actualWork,"NOT_VERIFIED");
  assert.equal(p.dispatch,"NOT_QUALIFIED");
  assert.equal(p.ownerStop,"UNKNOWN");
  assert.equal(p.heartbeat,"UNKNOWN");
 }
});
test("Owner STOP and disabled latch take priority over synthetic RUNNING and heartbeat",()=>{
 const p=projectSupervisorTelemetryProjection(good(),{nowMs:now});
 assert.equal(p.readOnly,true);
 assert.equal(p.ownerStop,"STOP_LATCH");
 assert.equal(p.autostart,"DISABLED_LATCH");
 assert.equal(p.selectedSot,"CONFIGURED_NOT_EXECUTING");
 assert.equal(p.sotUrl,sot);
 assert.equal(p.pending,"PENDING_SOT_REVIEW");
 assert.equal(p.pendingCount,1);
 assert.equal(p.heartbeat,"RECENT");
 assert.equal(p.actualWork,"NOT_VERIFIED");
 assert.equal(p.dispatch,"NOT_QUALIFIED");
 const html=renderProjectSupervisorTelemetry({selected:"supervisor/project-control/MPC-008",robot:good(),nowMs:now});
 assert.match(html,/Owner STOP đang có hiệu lực/);
 assert.match(html,/Đã khóa tự khởi động/);
 assert.match(html,/1 yêu cầu xem xét/);
 assert.match(html,/chưa đủ điều kiện/);
 assert.match(html,/chỉ đọc/);
 assert.doesNotMatch(html,/data-owner-start|data-owner-stop|method="POST"|>Đang chạy</);
});
test("wrong host or absent latch cannot be interpreted as Owner permission",()=>{
 const state=good();
 state.mpc_readonly_latches.host_verified=false;
 const p=projectSupervisorTelemetryProjection(state,{nowMs:now});
 assert.equal(p.ownerStop,"UNKNOWN");
 assert.equal(p.autostart,"UNKNOWN");
 const missing=good();
 missing.mpc_readonly_latches.owner_stop_marker=false;
 missing.mpc_readonly_latches.autostart_disabled_marker=false;
 missing.details["Owner STOP"]=false;
 const absent=projectSupervisorTelemetryProjection(missing,{nowMs:now});
 assert.equal(absent.ownerStop,"MARKER_ABSENT_NOT_AUTHORIZED");
 assert.equal(absent.autostart,"MARKER_ABSENT_NOT_AUTHORIZED");
 assert.equal(absent.actualWork,"NOT_VERIFIED");
 const staleGuardian=good();
 staleGuardian.mpc_readonly_latches.owner_stop_marker=false;
 // Cached guardian owner_stop=true may not claim a present live STOP marker.
 assert.equal(projectSupervisorTelemetryProjection(staleGuardian,{nowMs:now}).ownerStop,
  "MARKER_ABSENT_NOT_AUTHORIZED");
});
test("stale, future and unzoned heartbeat never prove activity",()=>{
 const stale=good();stale.last_seen="2026-10-14T08:00:00Z";
 assert.equal(projectSupervisorTelemetryProjection(stale,{nowMs:now}).heartbeat,"STALE");
 const future=good();future.last_seen="2026-10-15T10:00:00Z";
 assert.equal(projectSupervisorTelemetryProjection(future,{nowMs:now}).heartbeat,"UNKNOWN");
 const unzoned=good();unzoned.last_seen="2026-10-14T09:35:00";
 assert.equal(projectSupervisorTelemetryProjection(unzoned,{nowMs:now}).heartbeat,"UNKNOWN");
});
test("untrusted links, request lists and hostile URL never become selected SOT or approved tasks",()=>{
 for(const url of ["javascript:alert(1)","https://evil.example/SOURCE_OF_TRUTH.md",
  'https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md?q=1',
  'https://github.com/magasincoffee/magasin-supervisor/blob/main/OTHER.md']){
  const state=good();state.project_links.active.sot_url=url;
  const p=projectSupervisorTelemetryProjection(state,{nowMs:now});
  assert.equal(p.sotUrl,null);
  assert.equal(p.selectedSot,"UNKNOWN");
  const html=renderProjectSupervisorTelemetry({selected:"supervisor",robot:state,nowMs:now});
  assert.doesNotMatch(html,/href="javascript:|evil.example|OTHER.md/);
 }
 const invalid=good();invalid.project_links.requests=[{status:"APPROVED",execution_authorized:true}];
 assert.equal(projectSupervisorTelemetryProjection(invalid,{nowMs:now}).pending,"UNKNOWN");
 const enabled=good();enabled.project_links.business_dispatch_authorized=true;
 assert.equal(projectSupervisorTelemetryProjection(enabled,{nowMs:now}).pending,"UNKNOWN");
 assert.equal(projectSupervisorTelemetryProjection(enabled,{nowMs:now}).selectedSot,"UNKNOWN");
});
test("telemetry is isolated from workforce and other project selections",()=>{
 assert.equal(renderProjectSupervisorTelemetry({selected:"workforce",robot:good()}),"");
 assert.equal(renderProjectSupervisorTelemetry({selected:"supervisor-evil",robot:good()}),"");
 const html=renderProjectSupervisorTelemetry({selected:"supervisor",robot:{id:"supervisor"},nowMs:now});
 assert.match(html,/Chưa xác minh/);
 assert.match(html,/Chưa có bằng chứng xác minh/);
});
test("existing project detail gains a read-only telemetry panel and no robot controls",()=>{
 const catalogue={status:"LOCAL_UNVERIFIED",projects:[{
  id:"supervisor",title:"Supervisor",features:[{id:"project-control",title:"MPC",
   tasks:[{id:"MPC-008",title:"Trạng thái robot"}]}]}]};
 const html=renderProjectTree({catalogue,selected:"supervisor/project-control/MPC-008",
  supervisorSnapshot:good(),expanded:["supervisor","supervisor/project-control"]});
 assert.match(html,/Trạng thái Supervisor chỉ đọc/);
 assert.match(html,/Owner STOP đang có hiệu lực/);
 assert.doesNotMatch(html,/data-owner-start|data-owner-stop|method="POST"/);
});
test("existing same-origin route, timeout, fresh Owner probe and STOP read stay source-only",async()=>{
 const [server,app,tree,wf1,wf2]=await Promise.all([
  read("src/control-center/server.py"),
  read("src/control-center/web/app.js"),
  read("src/control-center/web/project_tree_view.mjs"),
  read(".github/workflows/supervisor-tests.yml"),
  read(".github/workflows/supervisor-integrity.yml")
 ]);
 assert.match(server,/mpc_readonly_latches/);
 assert.match(server,/host_verified/);
 assert.match(server,/\(SUP \/ "STOP"\)\.is_file\(\)/);
 assert.match(server,/\(SUP \/ "AUTOSTART_DISABLED"\)\.is_file\(\)/);
 assert.match(server,/if p\.startswith\("\/api\/robot\/"\):/);
 assert.match(server,/if p=="\/project_supervisor_telemetry\.mjs":/);
 assert.match(server,/WEB\/"project_supervisor_telemetry\.mjs"/);
 assert.match(app,/boundedProjectJson\("\/api\/robot\/supervisor"/);
 assert.match(app,/supervisorJob\.cancel\(\)/);
 assert.ok(app.indexOf("const observedSupervisor=await supervisorJob.value;")<
           app.indexOf("const freshSession=await finalSessionJob.value;"));
 assert.match(tree,/renderProjectSupervisorTelemetry\(\{selected,robot:supervisorSnapshot\}\)/);
 for(const wf of [wf1,wf2])assert.match(wf,/test\/mpc008-supervisor-telemetry\.test\.mjs/);
 assert.doesNotMatch(server,/if p==="\/api\/projects\/write":/);
});
