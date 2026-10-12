// MPC-005: read-only Vietnamese feature/task detail presentation. No worker or owner writes.
const escape=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ALLOWED={
 supervisor:"magasincoffee/magasin-supervisor",
 workforce:"magasincoffee/magasincoffee.github.io",
 "print-ops":"magasincoffee/OPS-WebApp"
};
const IDENT=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SHA=/^[a-f0-9]{40}$/;
const scopeLabels={UNKNOWN:"Chưa xác minh",CONFLICT:"Xung đột nguồn",PLANNED:"Đã lên kế hoạch",
 READY:"Sẵn sàng",IN_PROGRESS:"Đang thực hiện",BLOCKED:"Bị chặn",
 WAITING_OWNER:"Chờ Owner duyệt",VERIFIED_DONE:"Hoàn thành đã xác minh"};
const transportLabels={UNKNOWN:"Chưa có bằng chứng",STOPPED:"Đã dừng",RUNNING:"Đang chạy",
 WAITING:"Đang chờ",ERROR:"Có lỗi"};
const ciLabels={UNKNOWN:"Chưa xác minh",QUEUED:"Đang chờ kiểm thử",IN_PROGRESS:"Đang kiểm thử",
 SUCCESS:"CI PASS",FAILURE:"CI FAILED",CANCELLED:"Đã hủy"};
const releaseLabels={UNKNOWN:"Chưa xác minh",NOT_RELEASED:"Chưa phát hành",
 AWAITING_OWNER:"Chờ Owner duyệt",ACCEPTED:"Đã được chấp thuận",REJECTED:"Không được chấp thuận"};
const evidenceKinds={canonical_sot:"SOT chuẩn",task_dod:"Điều kiện hoàn thành",
 qa:"Kiểm thử",pr:"Pull request",ci:"GitHub Actions",exact_main:"Xác nhận main",
 owner_acceptance:"Owner nghiệm thu"};
function safeUrl(value,repo){
 if(typeof value!=="string"||!repo)return null;
 try{
   const u=new URL(value);
   if(u.origin!=="https://github.com"||u.username||u.password||u.search||u.hash)return null;
   const prefix="/"+repo+"/";
   if(!u.pathname.startsWith(prefix))return null;
   const rest=u.pathname.slice(prefix.length);
   if(/^blob\/(?:main|[a-f0-9]{40})\/[A-Za-z0-9_./-]+$/.test(rest)&&!rest.includes(".."))return u.href;
   if(/^pull\/[1-9][0-9]*$/.test(rest)||/^actions\/runs\/[1-9][0-9]*$/.test(rest))return u.href;
 }catch{}
 return null;
}
const li=(url,label,repo)=>{
 const href=safeUrl(url,repo);
 return href?'<a href="'+escape(href)+'" target="_blank" rel="noopener noreferrer">'+escape(label)+' ↗</a>':'<span>Không có đường dẫn đã xác minh</span>';
};
function selection(catalogue,key){
 if(typeof key!=="string"||key.length>250)return null;
 const parts=key.split("/");
 if(parts.length>3||!parts.every(p=>IDENT.test(p)))return null;
 const project=Array.isArray(catalogue?.projects)?catalogue.projects.find(p=>p?.id===parts[0]):null;
 if(!project||!Object.hasOwn(ALLOWED,project.id))return null;
 const feature=parts.length>1&&Array.isArray(project.features)?project.features.find(f=>f?.id===parts[1]):null;
 if(parts.length>1&&!feature)return null;
 const task=parts.length>2&&Array.isArray(feature?.tasks)?feature.tasks.find(t=>t?.id===parts[2]):null;
 if(parts.length>2&&!task)return null;
 const item=task??feature??project;
 return {title:item.title??"Chưa rõ",id:item.id,level:task?"Nhiệm vụ":feature?"Tính năng":"Dự án",
  repo:ALLOWED[project.id],projectId:project.id,
  source:item.sourceUrl??feature?.sourceUrl??project.sourceUrl??null};
}
const span=(title,value)=>'<div class="detail-status-item"><dt>'+escape(title)+'</dt><dd>'+escape(value)+'</dd></div>';
export function renderProjectDetail({catalogue,selected,detail=null}={}){
 if(!selected)return "";
 const item=selection(catalogue,selected);
 if(!item)return '<section class="project-detail" role="alert"><strong>Không tìm thấy mục đã chọn</strong><p>Đường dẫn không thuộc danh mục được phép. Không suy đoán trạng thái.</p></section>';
 const a=detail?.ok===true&&detail?.selected?.key===selected&&detail?.selected?.projectId===item.projectId &&
   detail?.authority?.source==="CANONICAL_MODEL"&&
   detail?.authority?.revision?.repo===item.repo&&SHA.test(detail?.authority?.revision?.sha??"")?
     detail.authority:null;
 const divergence=detail?.ok===true&&detail?.selected?.key===selected&&detail?.selected?.projectId===item.projectId&&detail?.authority?.source==="CONFLICT";
 const scope=divergence?"CONFLICT":a&&Object.hasOwn(scopeLabels,a.scope)?a.scope:"UNKNOWN";
 const transport=a&&Object.hasOwn(transportLabels,a.transport)?a.transport:"UNKNOWN";
 const ci=a&&Object.hasOwn(ciLabels,a.ci)?a.ci:"UNKNOWN";
 const release=a&&Object.hasOwn(releaseLabels,a.release)?a.release:"UNKNOWN";
 const immutableRevision=!!a?.revision?.url&&typeof a.revision.path==="string"&&
   a.revision.url==="https://github.com/"+item.repo+"/blob/"+a.revision.sha+"/"+a.revision.path;
 const revisionBound=new Set(["canonical_sot","task_dod","qa","exact_main"]);
 const evidence=a&&immutableRevision&&Array.isArray(a.evidence)?a.evidence.filter(e=>e&&Object.hasOwn(evidenceKinds,e.kind)&&
   e.verified===true&&e.sha===a.revision.sha&&safeUrl(e.url,item.repo)&&
   (!revisionBound.has(e.kind)||e.url===a.revision.url)):[];
 // Defence in depth: complete requires the minimum canonical DoD proof set,
 // regardless of any claimed scopeStatus in a display feed.
 const kinds=new Set(evidence.map(x=>x.kind));
 const complete=["canonical_sot","task_dod","qa","exact_main"].every(k=>kinds.has(k));
 const safeScope=scope==="VERIFIED_DONE"&&!complete?"UNKNOWN":scope;
 const conflict=safeScope==="CONFLICT";
 const reason=conflict?"Các nguồn hoặc phiên bản không khớp. Cần đối chiếu SOT và SHA.":
   !a?"Chưa có bộ bằng chứng nhiệm vụ được xác thực từ nguồn SOT chuẩn.":
   safeScope==="VERIFIED_DONE"?"Các điều kiện hoàn thành đã có bằng chứng được xác minh cùng phiên bản.":
   "Trạng thái nguồn đã đọc, nhưng chưa có đủ bằng chứng để xác nhận hoàn thành.";
 const revision=immutableRevision&&safeUrl(a.revision.url,item.repo)?a.revision.url:null;
 const evidenceHtml=evidence.map(e=>'<li><strong>'+escape(evidenceKinds[e.kind])+'</strong> · '+li(e.url,"Xem bằng chứng",item.repo)+'</li>').join("");
 return '<section class="project-detail" aria-label="Chi tiết mục đã chọn">'
  +'<div class="detail-heading"><div><span class="detail-kicker">'+escape(item.level)+'</span><h2>'+escape(item.title)+'</h2><p class="detail-code">Mã kỹ thuật: '+escape(item.id)+'</p></div><span class="project-unknown">'+escape(scopeLabels[safeScope])+'</span></div>'
  +'<p class="detail-explanation">'+escape(reason)+'</p>'
  +'<dl class="detail-status-grid">'
  +span("Tiến độ",scopeLabels[safeScope])
  +span("Hoạt động robot",transportLabels[transport])
  +span("CI / kiểm thử",ciLabels[ci])
  +span("Nghiệm thu / phát hành",releaseLabels[release])
  +'</dl>'
  +'<div class="detail-evidence"><h3>Nguồn thông tin</h3><p>SOT của dự án: '+li(item.source,"Mở nguồn tham khảo",item.repo)+'</p>'
  +'<p>Phiên bản đã kiểm tra: '+(revision?li(revision,a.revision.sha,item.repo):'<strong>Chưa xác minh SHA</strong>')+'</p>'
  +'<h3>PR, CI và bằng chứng</h3>'
  +(evidenceHtml?'<ul>'+evidenceHtml+'</ul>':'<p>Chưa có PR, CI hoặc hồ sơ DoD đủ điều kiện xác nhận ở nguồn chuẩn.</p>')
  +'<h3>Bước tiếp theo</h3><p>'+(conflict?'Đối chiếu các nguồn SOT và bản ghi revision trước khi kết luận.':
     safeScope==="VERIFIED_DONE"?'Kiểm tra riêng cổng nghiệm thu Owner và trạng thái phát hành nếu cần.':
     'Xác minh SOT chuẩn, revision và kiểm thử liên quan. Chỉ ghi nhận hoàn thành khi đủ điều kiện.')+'</p></div>'
  +'<p class="project-footer">Chỉ xem. Không gửi yêu cầu, sửa SOT, phát lệnh robot hoặc thay đổi production.</p></section>';
}
