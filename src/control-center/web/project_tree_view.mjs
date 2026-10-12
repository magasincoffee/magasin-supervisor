// MPC-004: pure read-only project-tree rendering. No mutation or worker controls.
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[char]));
const label = value => typeof value==="string" && value.trim() ? value : "Chưa rõ";
const compact = value => String(value??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("vi").trim();
const safeId = value => typeof value==="string" && /^[A-Za-z0-9_-]{1,70}$/.test(value);
const sourceLink = value => {
  if(typeof value!=="string") return null;
  try {
    const url=new URL(value);
    return url.protocol==="https:" && url.hostname==="github.com" &&
      /^\/magasincoffee\/[A-Za-z0-9_.-]+\/blob\/(main|[0-9a-f]{40})\/[A-Za-z0-9_.\/-]+$/.test(url.pathname)
      ? url.href : null;
  } catch { return null; }
};
export function projectTreeTrail(catalogue,selected="") {
  const trail=[{name:"Dự án",key:""}];
  for(const p of catalogue?.projects??[]) {
    if(!safeId(p.id))continue;
    const pk=p.id;
    if(selected===pk || selected.startsWith(pk+"/")) {
      trail.push({name:label(p.title),key:pk});
      for(const f of p.features??[]) {
        if(!safeId(f.id))continue;
        const fk=pk+"/"+f.id;
        if(selected===fk||selected.startsWith(fk+"/")) {
          trail.push({name:label(f.title),key:fk});
          for(const t of f.tasks??[]) {
            if(safeId(t.id) && selected===fk+"/"+t.id) trail.push({name:label(t.title),key:selected});
          }
        }
      }
      break;
    }
  }
  return trail;
}
export function renderProjectTree({catalogue,query="",expanded=[],selected=""}={}) {
  if(catalogue==null) return '<section class="project-page" role="status">Đang tải danh mục dự án từ Control Center…</section>';
  const projects=Array.isArray(catalogue?.projects)?catalogue.projects:[];
  const opened=new Set(expanded);
  const term=compact(String(query).slice(0,120));
  const has=x=>compact(x).includes(term);
  const statusBadge=()=>'<span class="project-unknown" aria-label="Trạng thái chưa xác minh">Chưa xác minh</span>';
  const link=(url,title="Mở Source of Truth")=>{
    const href=sourceLink(url);
    return href?'<a class="project-sot" href="'+escapeHtml(href)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(title)+' ↗</a>':"";
  };
  const tree=[];
  let visible=0;
  for(const p of projects) {
    if(!safeId(p.id))continue;
    const features=Array.isArray(p.features)?p.features:[];
    const matchingProject=term!==""&&(has(p.title)||has(p.id));
    const featureItems=[];
    for(const f of features) {
      if(!safeId(f.id))continue;
      const tasks=Array.isArray(f.tasks)?f.tasks:[];
      const matchingFeature=matchingProject || (term!==""&&(has(f.title)||has(f.id)));
      const taskItems=tasks.filter(t=>safeId(t.id)&&(!term||matchingFeature||has(t.title)||has(t.id)));
      if(term&&!matchingFeature&&!taskItems.length)continue;
      const fk=p.id+"/"+f.id;
      const fExpanded=term!==""||opened.has(fk);
      const taskRows=taskItems.map(t=>{
        const tk=fk+"/"+t.id;
        return '<li class="project-task"><button type="button" data-project-focus="'+escapeHtml(tk)+'" class="project-row '+(selected===tk?'is-active':'')+'" aria-current="'+(selected===tk?'true':'false')+'"><span class="project-row-title">'+escapeHtml(label(t.title))+'</span>'+statusBadge()+'</button></li>';
      }).join("");
      featureItems.push('<li class="project-feature"><div class="project-row-main"><button type="button" class="project-toggle" data-project-toggle="'+escapeHtml(fk)+'" aria-expanded="'+fExpanded+'" aria-label="'+(fExpanded?'Thu gọn ':'Mở rộng ')+escapeHtml(label(f.title))+'">'+(fExpanded?'−':'+')+'</button><button type="button" data-project-focus="'+escapeHtml(fk)+'" class="project-row '+(selected===fk?'is-active':'')+'"><strong>'+escapeHtml(label(f.title))+'</strong>'+statusBadge()+'</button></div>'
        +(fExpanded?'<ul class="project-subtree">'+(taskRows||'<li class="project-empty">Chưa có nhiệm vụ được xác minh</li>')+'</ul>':'')+'</li>');
    }
    if(term&&!matchingProject&&!featureItems.length)continue;
    visible++;
    const pk=p.id, pExpanded=term!==""||opened.has(pk);
    tree.push('<li class="project-item"><div class="project-row-main"><button type="button" class="project-toggle" data-project-toggle="'+escapeHtml(pk)+'" aria-expanded="'+pExpanded+'" aria-label="'+(pExpanded?'Thu gọn ':'Mở rộng ')+escapeHtml(label(p.title))+'">'+(pExpanded?'−':'+')+'</button><button type="button" data-project-focus="'+escapeHtml(pk)+'" class="project-row '+(selected===pk?'is-active':'')+'"><strong>'+escapeHtml(label(p.title))+'</strong>'+statusBadge()+'</button></div>'
      +(pExpanded?'<ul class="project-subtree">'+(featureItems.join("")||'<li class="project-empty">Chưa có tính năng/nhiệm vụ được xác minh từ SOT.</li>')+'</ul>':'')+'</li>');
  }
  const trail=projectTreeTrail(catalogue,selected);
  const crumbs='<nav class="project-breadcrumb" aria-label="Đường dẫn dự án">'+trail.map((part,i)=>i===trail.length-1?
    '<span aria-current="page">'+escapeHtml(part.name)+'</span>':
    '<button type="button" data-project-focus="'+escapeHtml(part.key)+'">'+escapeHtml(part.name)+'</button><span aria-hidden="true">›</span>').join("")+'</nav>';
  const selectedLink=(()=>{
    for(const p of projects) {
      if(!safeId(p.id)||!(selected===p.id||selected.startsWith(p.id+"/")))continue;
      if(selected===p.id)return link(p.sourceUrl);
      for(const f of p.features??[]) {
        if(!safeId(f.id)||!(selected===p.id+"/"+f.id||selected.startsWith(p.id+"/"+f.id+"/")))continue;
        if(selected===p.id+"/"+f.id)return link(f.sourceUrl||p.sourceUrl);
        for(const t of f.tasks??[])if(safeId(t.id)&&selected===p.id+"/"+f.id+"/"+t.id)return link(t.sourceUrl||f.sourceUrl||p.sourceUrl);
      }
    }
    return "";
  })();
  const error=catalogue?.status==="UNAVAILABLE";
  return '<section class="project-page" aria-label="Cây quản lý dự án">'
    +'<div class="project-intro"><strong>Danh mục dự án · chỉ đọc</strong><p>Trạng thái chưa có bằng chứng đủ điều kiện được giữ là <b>Chưa xác minh</b>. Không có chức năng START, giao việc hoặc chỉnh sửa SOT ở màn hình này.</p></div>'
    +crumbs
    +'<div class="project-toolbar"><label for="project-search">Tìm dự án, tính năng hoặc nhiệm vụ</label><input id="project-search" data-project-search type="search" maxlength="120" autocomplete="off" value="'+escapeHtml(query)+'" placeholder="Ví dụ: MPC-004, xếp lịch, Supervisor"></div>'
    +(error?'<p role="alert" class="project-error">Không đọc được danh mục dự án. Chưa có dữ liệu xác minh.</p>':'')
    +'<ul class="project-tree" aria-label="Danh sách dự án">'+tree.join("")+'</ul>'
    +(!visible?'<p class="project-empty" role="status">'+(term?'Không tìm thấy mục phù hợp.':'Chưa có dự án được xác minh.')+'</p>':'')
    +(selected?'<div class="project-selection"><strong>Thông tin mục đang chọn</strong><p>Trạng thái: Chưa xác minh · Chưa có dữ liệu nghiệp vụ được phê duyệt.</p>'+selectedLink+'</div>':'')
    +'<p class="project-footer">Danh sách từ nguồn SOT nội bộ chỉ dùng để điều hướng. Kiểm tra phiên bản GitHub, bằng chứng CI, trạng thái hoàn thành và tác vụ chi tiết thuộc các bước nghiệm thu tiếp theo.</p>'
    +'</section>';
}
