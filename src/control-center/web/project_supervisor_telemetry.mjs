// MPC-008: read-only local telemetry. Transport/heartbeat NEVER proves task execution.
// No command, mutation, Owner approval issuer, or project switch is available here.
const isRecord=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const allowedSelected=x=>typeof x==="string"&&(x==="supervisor"||x.startsWith("supervisor/"));
const escape=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const sourceUrl=x=>{
 if(typeof x!=="string"||x.length>300)return null;
 try{
  const u=new URL(x);
  if(u.origin!=="https://github.com"||u.username||u.password||u.search||u.hash)return null;
  const path=u.pathname;
  if(path==="/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md"||
     path==="/magasincoffee/OPS-WebApp/blob/main/SOURCE_OF_TRUTH.md"||
     path==="/magasincoffee/magasincoffee.github.io/blob/main/01_DOCS/MAGASIN/05_SYSTEM/WORKFORCE_CROSS_STORE_SCHEDULING_TEMP_SOURCE_OF_TRUTH.md")
    return u.href;
 }catch{}
 return null;
};
const blank=()=>({schema:"MPC-008_TELEMETRY_V1",readOnly:true,
 ownerStop:"UNKNOWN",autostart:"UNKNOWN",selectedSot:"UNKNOWN",sotUrl:null,
 pending:"UNKNOWN",pendingCount:null,heartbeat:"UNKNOWN",heartbeatAt:null,
 actualWork:"NOT_VERIFIED",dispatch:"NOT_QUALIFIED"});
export function projectSupervisorTelemetryProjection(robot,{nowMs=Date.now()}={}){
 const result=blank();
 if(!isRecord(robot)||robot.id!=="supervisor")return result;
 const latches=robot.mpc_readonly_latches;
 if(isRecord(latches)&&latches.schema==="MPC-008_LOCAL_LATCHES_V1"&&latches.host_verified===true){
  if(latches.owner_stop_marker===true || robot.details?.["Owner STOP"]===true)
   result.ownerStop="STOP_LATCH";
  else if(latches.owner_stop_marker===false)result.ownerStop="MARKER_ABSENT_NOT_AUTHORIZED";
  if(latches.autostart_disabled_marker===true)result.autostart="DISABLED_LATCH";
  else if(latches.autostart_disabled_marker===false)result.autostart="MARKER_ABSENT_NOT_AUTHORIZED";
 }
 const links=robot.project_links;
 if(isRecord(links)&&links.read_only===true&&links.worker_start_allowed===false&&
    links.business_dispatch_authorized===false&&Array.isArray(links.blockers)&&
    links.blockers.length===0&&Array.isArray(links.requests)&&links.requests.length<=500){
  const active=links.active;
  if(active===null)result.selectedSot="UNASSIGNED";
  else if(isRecord(active)&&active.execution_authorized===false){
   const url=sourceUrl(active.sot_url);
   if(url){result.selectedSot="CONFIGURED_NOT_EXECUTING";result.sotUrl=url;}
  }
  if(links.requests.every(row=>isRecord(row)&&row.status==="PENDING_SOT_REVIEW"&&
      row.execution_authorized===false)){
    result.pending="PENDING_SOT_REVIEW";
    result.pendingCount=links.requests.length;
  }
 }
 if(typeof robot.last_seen==="string"&&robot.last_seen.length<=45&&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(robot.last_seen)&&
    /(Z|[+-]\d\d:\d\d)$/.test(robot.last_seen)&&Number.isFinite(nowMs)){
   const observed=Date.parse(robot.last_seen);
   if(Number.isFinite(observed)&&observed<=nowMs+120000){
     result.heartbeat=nowMs-observed<=45*60*1000?"RECENT":"STALE";
     result.heartbeatAt=robot.last_seen;
   }
 }
 // Never derive business activity from robot.status, process count, phase or heartbeat.
 return result;
}
const stopLabels={UNKNOWN:"Chưa xác minh",STOP_LATCH:"Owner STOP đang có hiệu lực",
 MARKER_ABSENT_NOT_AUTHORIZED:"Chưa thấy khóa STOP; không đồng nghĩa được START"};
const autoLabels={UNKNOWN:"Chưa xác minh",DISABLED_LATCH:"Đã khóa tự khởi động",
 MARKER_ABSENT_NOT_AUTHORIZED:"Chưa thấy khóa tự khởi động; không được tự bật"};
const sotLabels={UNKNOWN:"Chưa xác minh SOT đang chọn",UNASSIGNED:"Chưa gắn SOT",
 CONFIGURED_NOT_EXECUTING:"Đã cấu hình liên kết; chưa chứng minh chạy"};
const heartbeatLabels={UNKNOWN:"Chưa có tín hiệu xác minh",RECENT:"Có tín hiệu gần đây (chỉ kết nối)",
 STALE:"Tín hiệu cũ (không xác minh công việc)"};
const cell=(name,value)=>'<div class="detail-status-item"><dt>'+escape(name)+'</dt><dd>'+escape(value)+'</dd></div>';
export function renderProjectSupervisorTelemetry({selected,robot=null,nowMs=Date.now()}={}){
 if(!allowedSelected(selected))return "";
 const t=projectSupervisorTelemetryProjection(robot,{nowMs});
 const count=t.pendingCount===null?"Chưa xác minh":String(t.pendingCount)+" yêu cầu xem xét (chưa phê duyệt)";
 const url=t.sotUrl?'<p class="mini"><a href="'+escape(t.sotUrl)+'" rel="noopener noreferrer" target="_blank">Mở SOT đã cấu hình ↗</a></p>':"";
 return '<section class="project-detail" aria-label="Trạng thái Supervisor chỉ đọc">'
  +'<h3>Supervisor — trạng thái quan sát (chỉ đọc)</h3>'
  +'<p class="mini">Trạng thái máy và heartbeat không phải bằng chứng robot đang xử lý nhiệm vụ.</p>'
  +'<dl class="detail-status-grid">'
  +cell("Owner STOP",stopLabels[t.ownerStop])
  +cell("Khóa tự khởi động",autoLabels[t.autostart])
  +cell("Liên kết SOT",sotLabels[t.selectedSot])
  +cell("Chờ xác minh / duyệt",count)
  +cell("Tín hiệu heartbeat",heartbeatLabels[t.heartbeat])
  +cell("Thực thi nghiệp vụ","Chưa có bằng chứng xác minh; chưa đủ điều kiện")
  +'</dl>'+url
  +'<p class="project-footer">Không có thao tác START, chuyển dự án, giao việc, ghi SOT hay phát hành từ trạng thái này.</p>'
  +'</section>';
}
