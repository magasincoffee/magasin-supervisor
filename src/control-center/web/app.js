"use strict";
const ROOT="/";
const root=document.getElementById("main-content");
const alertBox=document.getElementById("loading");
const nameTitle=document.getElementById("page-title");
const subtitle=document.getElementById("page-subtitle");
const navRobots=document.getElementById("nav-robots");
let latest=null;
let monitorState=null;
let busy=false;
const esc=(value)=>String(value??"—").replace(/[&<>"']/g, (c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtDate=(v)=>{if(!v)return "Chưa có";const d=new Date(v);return Number.isNaN(d.getTime())?"Không rõ":d.toLocaleString("vi-VN")};
const allItems=()=>[...(latest?.coordinator?[latest.coordinator]:[]),...(latest?.robots||[]),...(latest?.services||[])];
const count=(kind)=>latest?.robots?.filter(x=>x.status===kind).length||0;
const safeHref=(url)=>{try{const u=new URL(url,location.origin); if((u.protocol==="http:"&&u.hostname==="127.0.0.1"&&u.port==="8776")||(u.protocol==="https:"&&u.hostname==="github.com"))return u.href;}catch(e){}return null;};
const monitorPanel=()=>{
 const m=monitorState||{};
 const h=m.chatgpt||{state:"loading",label:"Đang đọc heartbeat",schedule:"Kiểm tra mỗi giờ"};
 const local=m.local_30m||{state:"unverified",label:"Chưa có heartbeat",actions:[],business_execution:"NOT_QUALIFIED"};
 const localBadge=local.state==="fresh"?(local.error_count>0?"review":"done"):local.state==="unverified"?"review":"error";
 const workNames=(local.actions||[]).map(a=>esc(a.name)+": "+esc(a.state)).join(" · ")||"Chưa có lượt kiểm tra được xác nhận.";
 const q=m.dispatch||{recent:[],available:false,waiting_authority:0};
 const c=latest?.coordinator||{status:"stopped",label:"Không rõ",details:{}};
 const s=(latest?.robots||[]).find(x=>x.id==="supervisor")||{status:"offline",label:"Chưa kết nối",phase:"Chưa rõ"};
 const hbStatus=h.state==="fresh"?(["ERROR","BLOCKED_TECHNICAL","WAIT_OWNER"].includes(h.result)?"review":"done"):h.state==="unverified"||h.state==="loading"?"review":"error";
 const issue=safeHref(h.issue_url)||"https://github.com/magasincoffee/magasin-supervisor/issues/346";
 const evidence=safeHref(h.evidence_url);
 const rows=(q.recent||[]).slice(0,7).map(r=>{
   const url=safeHref(r.issue_url);
   const task=esc(r.task_id);
   return '<tr><td>'+(url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+task+' ↗</a>':task)
    +'</td><td>'+esc(r.target)+'</td><td>'+esc(r.action)+'</td><td>'+esc(r.status)+'</td><td>'+esc(fmtDate(r.updated_at))+'</td></tr>';
 }).join("");
 return '<section class="section-title"><h2>Giám sát &amp; điều phối — bằng chứng thực tế</h2><span>Không đánh đồng lịch ChatGPT với robot đang chạy</span></section>'
 +'<div class="monitor-grid">'
 +'<article class="panel monitor-tile"><div class="monitor-title"><strong>🔄 Local — kiểm tra 30 phút</strong><span class="badge '+localBadge+'">'+esc(local.label)+'</span></div>'
 +'<p class="mini"><b>Lần chạy xác nhận:</b> '+esc(fmtDate(local.checked_at))+'</p>'
 +'<p class="mini"><b>Kết quả:</b> '+esc(local.result||"Chưa xác nhận")+'</p>'
 +'<p class="mini"><b>Các bước đã thực hiện:</b> '+workNames+'</p>'
 +'<p class="mini"><b>Thực thi nghiệp vụ:</b> '+(local.business_execution==="NOT_QUALIFIED_NO_SOT_ADAPTER"?"Đang chờ adapter SOT":esc(local.business_execution||"Chưa có"))+'</p>'
 +'<p class="mini"><a href="https://github.com/magasincoffee/magasin-supervisor/issues/347" target="_blank" rel="noopener noreferrer">Xem bằng chứng local #347 ↗</a></p></article>'
 +'<article class="panel monitor-tile"><div class="monitor-title"><strong>🧭 ChatGPT giám sát theo lịch</strong><span class="badge '+hbStatus+'">'+esc(h.label)+'</span></div>'
 +'<p class="mini">Tần suất: '+esc(h.schedule||"Mỗi giờ")+'</p>'
 +'<p class="mini"><b>Lượt kiểm tra xác nhận:</b> '+esc(fmtDate(h.last_checked))+'</p>'
 +'<p class="mini"><b>Kết quả:</b> '+esc(h.result||"Chưa có kết quả")+'</p>'
 +'<p class="mini">'+esc(h.summary||"Chưa có heartbeat.")+'</p>'
 +'<p class="mini"><b>Thao tác gần nhất:</b> '+esc(h.action||"Chưa có")+'</p>'
 +'<p class="mini"><a href="'+esc(issue)+'" target="_blank" rel="noopener noreferrer">Xem nhật ký ChatGPT trên GitHub ↗</a>'
 +(evidence?' · <a href="'+esc(evidence)+'" target="_blank" rel="noopener noreferrer">Bằng chứng ↗</a>':"")+'</p></article>'
 +'<article class="panel monitor-tile"><div class="monitor-title"><strong>🧠 Robot Tổng — điều phối local</strong><span class="badge '+esc(c.status)+'">'+esc(c.label)+'</span></div>'
 +'<p class="mini"><b>Hồ sơ đã phân loại:</b> '+esc(c.details?.["Hồ sơ đã phân loại"]??0)+'</p>'
 +'<p class="mini"><b>Lần phân tích:</b> '+esc(fmtDate(c.last_seen))+'</p>'
 +'<p class="mini"><b>Quyền Owner:</b> '+esc(c.control?.mode||"Chưa xác minh")+' — Chỉ giám sát SOT.</p>'
 +'<p class="mini"><b>Tự giao nhiệm vụ:</b> Chưa có Business Executor đủ điều kiện.</p>'
 +'<p class="mini"><b>Tự sửa / QA:</b> Chưa có bộ thực thi được nghiệm thu.</p>'
 +'<button type="button" class="monitor-link" data-open="coordinator">Xem Robot Tổng →</button></article>'
 +'<article class="panel monitor-tile"><div class="monitor-title"><strong>🖥️ Supervisor — thực thi WebApp</strong><span class="badge '+esc(s.status)+'">'+esc(s.label)+'</span></div>'
 +'<p class="mini"><b>Giai đoạn:</b> '+esc(s.phase)+'</p>'
 +'<p class="mini"><b>Tiến trình thực tế:</b> '+esc((s.processes||[]).length)+' tiến trình nhận diện.</p>'
 +'<p class="mini"><b>Outbound:</b> '+esc(s.details?.["Giao dịch gửi lệnh"]||"Chưa rõ")+'</p>'
 +'<p class="mini"><b>Báo cáo:</b> Chỉ xác nhận hoàn tất nếu QA/CI và SOT đạt.</p>'
 +'<button type="button" class="monitor-link" data-open="supervisor">Xem Supervisor →</button></article></div>'
 +'<section class="panel monitor-queue"><div class="monitor-title"><strong>Hàng đợi GitHub → MCP local</strong>'
 +'<span class="badge '+(q.available?"done":"error")+'">'+(q.available?"Đã đọc SQLite":"Không xác minh được")+'</span></div>'
 +'<p class="mini">Các bản ghi kỹ thuật gần nhất; DONE của health_check không phải hoàn thành nghiệp vụ. Chờ SOT trong mẫu: '+esc(q.waiting_authority??0)+'. Cập nhật: '+esc(fmtDate(q.last_updated))+'</p>'
 +(rows?'<div class="monitor-scroll"><table class="process-table"><thead><tr><th>Task</th><th>Robot</th><th>Lệnh</th><th>Trạng thái</th><th>Cập nhật</th></tr></thead><tbody>'+rows+'</tbody></table></div>':'<p class="mini">Chưa có dữ liệu hàng đợi đã được xác minh.</p>')+'</section>';
};
const coordinatorPanel=()=>{
 const c=latest.coordinator;
 const gh=latest.services?.[0]?.details?.["Trạng thái GitHub"]||"Chưa rõ";
 return '<section class="section-title"><h2>Tầng nhận lệnh và điều phối</h2></section>'
 + '<div class="dispatch-chain"><div class="chain-sources">'
 + '<div class="chain-node"><strong>GitHub</strong><small>'+esc(gh)+'</small></div>'
 + '<div class="chain-node"><strong>Supabase riêng</strong><small>Chờ tạo dự án</small></div>'
 + '</div><div class="chain-down">↓ Tiếp nhận và kiểm tra yêu cầu</div>'
 + '<article class="robot-card coordinator-card" tabindex="0" role="link" data-open="coordinator" aria-label="Chi tiết Robot Tổng">'
 + '<div class="card-head"><div class="robot-icon">'+esc(c.icon)+'</div><span class="badge '+esc(c.status)+'">'+esc(c.label)+'</span></div>'
 + '<h3>ROBOT TỔNG — ĐIỀU PHỐI</h3>'
 + '<p>Nhận lệnh → kiểm tra SOT → phân tích → chọn robot → giao nhiệm vụ → kiểm chứng kết quả và giao sửa khi chưa đạt.</p>'
 + '<div class="robot-footer"><span>Hồ sơ định tuyến: '+esc(c.details["Hồ sơ đã phân loại"])+'</span><strong>Chi tiết →</strong></div></article>'
 + '<div class="chain-down">↓ Giao việc khi Owner đã bật đúng robot chuyên môn</div></div>';
};
const migrationWarnings={
 "SUPERVISOR_OUTBOUND_UNKNOWN_OUTCOME_NO_RESEND":"Lệnh đang chờ, chưa xác minh đã gửi thành công; không được gửi trùng",
 "SUPERVISOR_OUTBOUND_UNVERIFIED":"Chưa xác minh trạng thái giao dịch gửi lệnh",
 "SUPERVISOR_OUTBOUND_DELIVERY_NOT_INDEPENDENTLY_VERIFIED":"Kết quả gửi lệnh chưa được xác minh độc lập",
 "SUPERVISOR_STOP_LATCH_PRESENT_OR_UNKNOWN":"Owner STOP hoặc khóa tự khởi động vẫn còn hiệu lực",
 "SUPERVISOR_OWNER_LIFECYCLE_NOT_QUALIFIED":"Chưa nghiệm thu START/STOP thực tế của Supervisor",
 "SAYDI_CHAPTER_REVIEW_NOT_FINAL":"Chương sách đã có bản nghe duyệt, chưa xác nhận FINAL",
 "SAYDI_CHAPTER_QC_WAIT_RESOURCE":"QC chương sách đang chờ tài nguyên",
 "SAYDI_CHAPTER_CHECKPOINT_UNVERIFIED":"Chưa xác minh checkpoint chương sách",
 "SAYDI_WORKER_ACTIVITY_NOT_SAFE_TO_INTERRUPT":"Có công việc đang chạy; không được ép dừng",
 "SAYDI_WORKER_UNVERIFIED":"Chưa xác minh tiến trình sách nói",
 "SAYDI_QC_RAM_BELOW_GATE":"RAM trống dưới 2,3 GiB để chạy QC",
 "SAYDI_FREE_RAM_UNVERIFIED":"Không xác minh được RAM trống",
 "LEGACY_AUTOSTART_UNRECONCILED":"Lịch tự khởi động cũ chưa được chuyển đổi",
 "SAYDI_OWNER_CONTROL_NOT_QUALIFIED":"Bộ điều khiển Owner của SAYDI chưa nghiệm thu",
 "SAPO_PENDING_EXPORT_NOT_RECONCILED":"Còn bản xuất doanh thu chờ đối soát",
 "SAPO_LAST_SUCCESS_NOT_INDEPENDENTLY_VERIFIED":"Kết quả đồng bộ cũ chưa được xác minh độc lập",
 "SAPO_FINANCIAL_CHECKPOINT_UNVERIFIED":"Chưa chứng minh trạng thái đối soát an toàn",
 "SAPO_RECENT_DIAGNOSTIC_REQUIRES_REVIEW":"Nhật ký SAPO có dấu hiệu lỗi cần kiểm tra",
 "SAPO_FINANCIAL_STOP_CHECKPOINT_NOT_QUALIFIED":"Không được dừng hoặc chạy lại đồng bộ khi checkpoint chưa rõ",
 "SAPO_LOGS_UNAVAILABLE":"Chưa có nhật ký SAPO đáng tin cậy",
 "SAPO_STATE_NOT_READABLE":"Không thể đọc trạng thái SAPO",
 "SAPO_STATE_INVALID":"Dữ liệu trạng thái SAPO không hợp lệ",
 "READ_ONLY_PRECUTOVER_EVIDENCE_UNAVAILABLE":"Chưa kết nối được bộ kiểm tra trước chuyển đổi"
};
const migrationPanel=()=>{
 const p=latest?.migration_preflight;
 if(!p)return '<section class="panel"><h3>Chuyển đổi về một Control Center</h3><p class="mini">Chưa có dữ liệu kiểm tra trước chuyển đổi.</p></section>';
 const names={supervisor:"Supervisor / WebApp",saydi:"SAYDI Media",sapo:"SAPO Sync"};
 const sections=["supervisor","saydi","sapo"].map(id=>{
  const evidence=p.robots?.[id]||{};
  const blocked=(evidence.blockers||[]).slice(0,8).map(k=>'<li>'+esc(migrationWarnings[k]||k)+'</li>').join("");
  return '<article class="panel"><div class="monitor-title"><strong>'+esc(names[id])+'</strong><span class="badge review">Chưa thể chuyển đổi</span></div>'
    +'<ul class="mini">'+(blocked||'<li>Thiếu bằng chứng vận hành</li>')+'</ul>'
    +'<p class="mini">Quyền START/STOP mới: chưa được nghiệm thu. Không thao tác với lịch cũ.</p></article>';
 }).join("");
 return '<section class="section-title"><h2>Chuyển đổi về một Control Center</h2><span>MIG-CC-01 · Kiểm tra an toàn trước chuyển đổi</span></section>'
   +'<p class="mini">Dữ liệu chỉ đọc; không bật, tắt hay xóa robot. Không công bố đường dẫn xuất dữ liệu SAPO.</p>'
   +'<div class="monitor-grid">'+sections+'</div>'
   +'<p class="mini">Kết quả: '+esc(p.status||"Chưa rõ")+' · Cập nhật: '+esc(fmtDate(p.checked_at_utc))+'</p>';
};
const cards=()=>{
 const b=latest.robots.map(r=>`
 <article class="robot-card" tabindex="0" role="link" data-open="${esc(r.id)}" aria-label="Chi tiết ${esc(r.name)}">
  <div class="card-head"><div class="robot-icon">${esc(r.icon)}</div><span class="badge ${esc(r.status)}">${esc(r.label)}</span></div>
  <h3>${esc(r.name)}</h3><p>${esc(r.summary)}</p>
  <div class="robot-footer"><span>${esc(r.category)}</span><strong>Chi tiết →</strong></div>
 </article>`).join("");
 return `<section class="callout"><strong>Owner quyết định robot nào hoạt động.</strong> Trạng thái hiển thị theo bằng chứng; Bắt đầu/Dừng chỉ có hiệu lực khi robot riêng đó qua cổng an toàn. Mở chi tiết bằng cách chọn một robot bên dưới.</section>
  ${monitorPanel()}
  ${migrationPanel()}
  ${coordinatorPanel()}
  <div class="overview-kpis">
    <div class="kpi"><small>Robot đang hoạt động</small><strong>${count("running")}</strong><span class="unit">/${latest.robots.length}</span></div>
    <div class="kpi"><small>Đang có lỗi</small><strong>${count("error")+count("offline")}</strong></div>
    <div class="kpi"><small>RAM đang sử dụng</small><strong>${esc(latest.system.ram_percent)}%</strong></div>
    <div class="kpi"><small>RAM còn trống</small><strong>${esc(latest.system.ram_free_gb)}</strong><span class="unit">GB</span></div>
  </div>
  <div class="section-title"><h2>Danh sách robot độc lập</h2><span>Chọn một robot để vào chi tiết</span></div>
  <section class="robot-grid">${b}</section>
  <div class="section-title"><h2>Dịch vụ nền</h2><span>Không phải robot chuyên trách</span></div>
  <section class="robot-grid">${(latest.services||[]).map(r=>`<article class="robot-card" tabindex="0" role="link" data-open="${esc(r.id)}"><div class="card-head"><div class="robot-icon">${esc(r.icon)}</div><span class="badge ${esc(r.status)}">${esc(r.label)}</span></div><h3>${esc(r.name)}</h3><p>${esc(r.summary)}</p><div class="robot-footer"><span>Hạ tầng local</span><strong>Chi tiết →</strong></div></article>`).join("")}</section>
  <div class="section-title"><h2>Sức khỏe máy tính</h2></div>
  <div class="overview-kpis">
    <div class="kpi"><small>CPU</small><strong>${esc(latest.system.cpu_percent)}%</strong></div>
    <div class="kpi"><small>RAM tổng</small><strong>${esc(latest.system.ram_total_gb)}</strong><span class="unit">GB</span></div>
    <div class="kpi"><small>Ổ C còn trống</small><strong>${esc(latest.system.disk_c_free_gb)}</strong><span class="unit">GB</span></div>
    <div class="kpi"><small>Ổ D còn trống</small><strong>${esc(latest.system.disk_d_free_gb)}</strong><span class="unit">GB</span></div>
  </div>`;
};
function coordinatorPlans(r){
 if(r.id!=="coordinator")return "";
 const plans=r.route_plans||[];
 const rows=plans.slice(0,8).map(p=>'<tr><td>'+esc(p.task_id)+'</td><td>'+esc(p.specialist)+'</td><td>'+esc(p.stage)+'</td></tr>').join("");
 return '<section class="panel robot-tools"><h3>Hồ sơ công việc từ GitHub/Supabase</h3>'
  +'<p class="mini">Bộ định tuyến đã phân loại đầu vào; chưa xác nhận SOT hoặc chuyển lệnh nghiệp vụ sang robot khác.</p>'
  +(rows?'<table class="process-table"><thead><tr><th>Nhiệm vụ</th><th>Robot đích</th><th>Giai đoạn</th></tr></thead><tbody>'+rows+'</tbody></table>'
  :'<p class="mini">Chưa có hồ sơ nào.</p>')+'</section>';
}
const explainBlocker=(reason)=>{
 const local={
  "CHƯA_CÓ_BỘ_ĐIỀU_KHIỂN_START_STOP_ĐƯỢC_NGHIỆM_THU":"Chưa có bộ START/STOP được kiểm thử cho robot này",
  "CHƯA_KIỂM_THỬ_START_STOP_THỰC_TẾ":"Chưa nghiệm thu thao tác START/STOP với robot thật",
  "TRẠNG_THÁI_OWNER_CHƯA_XÁC_MINH_OFF":"Chưa xác minh quyền bật riêng của Owner",
  "THIẾU_RAM_CHO_SAYDI":"RAM khả dụng dưới ngưỡng khởi động QC an toàn",
  "CHƯA_XÁC_MINH_RAM_TRỐNG":"Không đọc được lượng RAM trống",
  "QC_CHƯƠNG_2_ĐANG_CHỜ_TÀI_NGUYÊN":"QC chương 2 đang tạm dừng để chờ tài nguyên",
  "MEDIA_CONTROL_CHƯA_PHẢN_HỒI":"SAYDI Media Control không phản hồi",
  "TRẠNG_THÁI_SAYDI_CHƯA_ĐỦ_MỚI":"Trạng thái Media Control quá cũ hoặc không hợp lệ",
  "PHÁT_HIỆN_CÔNG_VIỆC_MEDIA_ĐANG_CHẠY_KHÔNG_TỰ_DỪNG":"Có công việc media cần xử lý theo checkpoint",
  "SAPO_CÓ_LỊCH_ĐỒNG_BỘ_CŨ_CHƯA_CHUYỂN_SANG_OWNER_CONTROL":"SAPO còn lịch đồng bộ cũ chưa chuyển sang quyền Owner",
  "KHÔNG_ĐƯỢC_DỪNG_ĐỐI_SOÁT_HOẶC_GHI_DỮ_LIỆU_KHI_CHƯA_XÁC_MINH":"Không được dừng đối soát hoặc cập nhật doanh thu khi chưa xác minh",
  "THIẾU_MANIFEST_ROBOT_HỢP_LỆ":"Chưa đọc được cấu hình robot hợp lệ",
  "KHÔNG_ĐỌC_ĐƯỢC_BẰNG_CHỨNG_ĐIỀU_KHIỂN":"Bộ đọc trạng thái điều khiển không phản hồi"
 };
 return local[String(reason)]||String(reason||"Chưa có bằng chứng");
};
const specialistBlockers=(r)=>{
 if(r.id!=="saydi"&&r.id!=="sapo")return "";
 const blockers=(r.control?.start_blockers||[]).map(x=>'<li>'+esc(explainBlocker(x))+'</li>').join("");
 return '<section class="panel robot-tools"><h3>Vì sao chưa thể bật / tắt?</h3>'
  +'<p class="mini">Nút bị khóa để bảo vệ công việc đang chạy và dữ liệu thật; không phải lỗi bấm chuột.</p>'
  +(blockers?'<ul class="mini">'+blockers+'</ul>':'<p class="mini">Chưa nhận được báo cáo kiểm tra.</p>')
  +'<p class="mini"><b>Hướng xử lý:</b> '+esc(r.control?.recovery_hint||"Cần nghiệm thu riêng bộ điều khiển của robot.")+'</p>'
  +'<p class="mini"><b>Đã kiểm tra quyền Owner riêng:</b> '+(r.control?.owner_authority_verified?"Có":"Chưa")+'</p>'
  +'<p class="mini"><b>Giao việc thật:</b> Chưa được cấp quyền.</p></section>';
};
function renderDetail(r){
 const cells=Object.entries(r.details||{}).map(([k,v])=>`<div class="metric"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
 const links=(r.links||[]).map(x=>{const url=safeHref(x.url);return url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(x.title)} ↗</a>`:""}).join("");
 const procs=(r.processes||[]).slice(0,18).map(p=>`<tr><td>${esc(p.pid)}</td><td>${esc(p.name||p.kind)}</td><td>${esc(p.memory_mb??p.ram_mb??"—")}</td></tr>`).join("");
 return `<div class="breadcrumb"><button class="back" type="button" data-open="home">← Tổng quan</button> <span>/</span><span>${esc(r.name)}</span></div>
 <section class="panel">
   <div class="detail-hero"><div class="detail-heading"><div class="robot-icon">${esc(r.icon)}</div><div><h2>${esc(r.name)}</h2><p>${esc(r.category)}</p></div></div><span class="badge ${esc(r.status)}">${esc(r.label)}</span></div>
   <p class="detail-phase"><strong>Giai đoạn:</strong> ${esc(r.phase)}</p>
   <p class="mini">Cập nhật: ${esc(fmtDate(r.last_seen))}</p>
   <div class="actions">
     <button type="button" class="btn btn-good" ${(r.id==="supervisor"||r.id==="coordinator")&&r.control?.start_allowed?'data-owner-start="'+esc(r.id)+'"':"disabled"} title="Chỉ khởi động khi qua kiểm tra giao dịch, SOT và tài nguyên">▶ Bắt đầu</button>
     <button type="button" class="btn btn-stop" ${(r.id==="supervisor"||r.id==="coordinator")&&r.control?.stop_allowed?'data-owner-stop="'+esc(r.id)+'"':"disabled"} title="Dừng riêng Supervisor theo quyền Owner; không ảnh hưởng SAYDI/SAPO">■ Dừng</button>
   </div>
   <p class="mini">${r.id==="supervisor"
     ?("Supervisor đang được bảo vệ: "+(r.control?.start_blockers||[]).map(esc).join(" "))
     :(r.id==="coordinator"?
        ("START chỉ cấp quyền giám sát SOT. "+(r.control?.start_blockers||[]).map(esc).join(" ")):
        "Nút đang khóa do thiếu điều kiện kiểm thử. Xem chi tiết nguyên nhân bên dưới.")}</p>
 </section>
 ${specialistBlockers(r)}
 <div class="detail-columns">
   <section class="panel"><h3>Trạng thái và tiến độ</h3><dl class="metrics">${cells}</dl></section>
   <section class="panel"><h3>Thư mục và tài liệu</h3><p class="mini">${esc(r.summary)}</p><p class="mini"><b>Thư mục quản lý trên ổ D</b></p><div class="path">${esc(r.organized_folder)}</div><p class="mini"><b>Runtime hiện tại (giữ nguyên)</b></p><div class="path">${esc(r.root)}</div><div class="actions">${links}</div></section>
 </div>
 ${coordinatorPlans(r)}
 ${r.id==="coordinator"||r.id==="supervisor"?monitorPanel():""}
 ${r.id==="coordinator"?migrationPanel():""}
 <div class="detail-columns robot-tools">
    <section class="panel"><h3>Tiến trình liên quan</h3>${procs?`<table class="process-table"><thead><tr><th>PID</th><th>Ứng dụng</th><th>RAM (MB)</th></tr></thead><tbody>${procs}</tbody></table>`:'<p class="mini">Không ghi nhận tiến trình chuyên môn đang chạy, hoặc chưa có bộ phát hiện được xác minh.</p>'}</section>
    <section class="panel"><h3>Thông tin vận hành</h3><p class="mini">${esc(r.notes)}</p><p class="mini">Robot này giữ SOT, tiến trình, Chrome profile, cấu hình và dữ liệu riêng. Không chia sẻ trạng thái START/STOP với robot khác.</p></section>
 </div>`;
}
function openPage(id,historyUpdate=true){
 const page=id==="home"||!allItems().some(x=>x.id===id)?"home":id;
 if(historyUpdate)history.pushState({page},"",page==="home"?"/":"/robot/"+page);
 nameTitle.textContent=page==="home"?"Trung tâm điều khiển Robot":allItems().find(x=>x.id===page).name;
 subtitle.textContent=page==="home"?"Mỗi robot độc lập, một nơi để theo dõi và điều khiển.":"Xem trạng thái và chi tiết robot trong cùng một bảng điều khiển.";
 root.innerHTML=page==="home"?cards():renderDetail(allItems().find(x=>x.id===page));
 document.querySelectorAll("[data-page]").forEach(x=>x.classList.toggle("selected",x.dataset.page===page));
 if(historyUpdate)window.scrollTo({top:0,behavior:"auto"});
}
function currentPage(){const x=location.pathname.match(/^\/robot\/(coordinator|supervisor|saydi|sapo|gateway)$/);return x?x[1]:"home"}
async function refresh(){
 if(busy)return;busy=true;
 try{
   const [res,monRes]=await Promise.all([
     fetch("/api/overview",{cache:"no-store"}),
     fetch("/api/monitor",{cache:"no-store"}).catch(()=>null)
   ]);
   if(!res.ok)throw Error("HTTP "+res.status);
   latest=await res.json();
   try {
     monitorState=monRes?.ok?await monRes.json():{chatgpt:{state:"unavailable",label:"Không xác minh được",summary:"Bộ đọc trạng thái chưa phản hồi."},dispatch:{available:false,recent:[]}};
   }catch(err){
     monitorState={chatgpt:{state:"unavailable",label:"Lỗi đọc dữ liệu"},dispatch:{available:false,recent:[]}};
   }
   navRobots.innerHTML=allItems().map(r=>`<button type="button" class="nav-link" data-page="${esc(r.id)}" data-open="${esc(r.id)}"><span class="nav-ico">${esc(r.icon)}</span><span>${esc(r.name)}</span></button>`).join("");
   document.getElementById("updated").textContent="Làm mới: "+fmtDate(latest.updated);
   alertBox.hidden=true;
   const page=currentPage();openPage(page,false);
 }catch(err){alertBox.hidden=false;alertBox.textContent="Không đọc được trạng thái local. "+(err?.message||"Hãy kiểm tra dịch vụ Control Center.");}
 finally{busy=false}
}
document.getElementById("refresh").addEventListener("click",refresh);
document.addEventListener("click",async(e)=>{
 const stop=e.target.closest("[data-owner-stop]");
 const start=e.target.closest("[data-owner-start]");
 const chosen=stop||start;
 if(chosen){
   const action=start?"start":"stop";
   const robot=chosen.dataset.ownerStart||chosen.dataset.ownerStop;
   if(robot!=="supervisor"&&robot!=="coordinator")return;
   const warning=robot==="coordinator"?
     (start?"Xác nhận START Robot Tổng chế độ GIÁM SÁT SOT? Không bật robot con hay thực thi nghiệp vụ.":
       "Xác nhận STOP giám sát Robot Tổng? Lịch kiểm tra kỹ thuật độc lập vẫn hoạt động."):
     (start?"Xác nhận BẮT ĐẦU riêng Supervisor? Mỗi giao dịch phải kiểm tra chống gửi trùng.":
       "Xác nhận DỪNG riêng Supervisor? Không ép tắt giao dịch chưa xác minh.");
   if(!confirm(warning))return;
   chosen.disabled=true;
   try{
     const route=robot==="coordinator"?"/api/coordinator/control":"/api/supervisor/control";
     const confirmation=robot==="coordinator"?
       (start?"START_COORDINATOR_READ_ONLY":"STOP_COORDINATOR"):
       (start?"START_SUPERVISOR":"STOP_SUPERVISOR");
     const response=await fetch(route,{
       method:"POST",
       headers:{"Content-Type":"application/json","X-MAGASIN-CSRF":latest.csrf},
       body:JSON.stringify({action,confirm:confirmation})
     });
     const outcome=await response.json();
     alert(outcome.message||"Yêu cầu đã được xử lý");
   }catch(err){alert("Không kết nối được bộ điều khiển: "+(err?.message||"Lỗi"))}
   await refresh();
   return;
 }
 const button=e.target.closest("[data-open]");
 if(button)openPage(button.dataset.open);
});
document.addEventListener("keydown",(e)=>{if(e.key==="Enter"&&e.target.matches(".robot-card"))openPage(e.target.dataset.open)});
window.addEventListener("popstate",()=>{if(latest)openPage(currentPage(),false)});
setInterval(()=>{if(!document.hidden)refresh()},20000);
refresh();