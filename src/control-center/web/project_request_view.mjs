// MPC-006: Owner-only intent draft UI. No task dispatch, SOT writes, or runtime controls.
const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({
 "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[c]));
const safeId=v=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,70}$/.test(v);

export function selectedRequestTarget(catalogue,selected) {
 if(typeof selected!=="string")return null;
 const bits=selected.split("/");
 if(bits.length!==3||!bits.every(safeId))return null;
 for(const p of catalogue?.projects??[])
  if(p.id===bits[0])
   for(const f of p.features??[])
    if(f.id===bits[1])
     for(const t of f.tasks??[])
      if(t.id===bits[2])return {key:selected,name:String(t.title??t.id).slice(0,150)};
 return null;
}

// Discard any response from a submission whose task, draft, or Owner session
// changed while its network request was in flight. This includes A -> B -> A.
export function isCurrentOwnerSubmission({
 submittedTarget,selectedTarget,submittedEpoch,currentEpoch,authenticated
}={}) {
 return authenticated===true && typeof submittedTarget==="string" &&
  submittedTarget===selectedTarget && Number.isSafeInteger(submittedEpoch) &&
  submittedEpoch===currentEpoch;
}

export function renderOwnerRequestPanel({
 catalogue,selected,session,draft={},receipt=null,error="",logoutUnconfirmed=false,
 logoutAvailable=false
}={}) {
 // An unacknowledged server logout may leave a valid HttpOnly cookie. Hide all
 // private material and provide an explicit retry even if catalogue is down.
 if(logoutUnconfirmed)return '<section class="owner-request" aria-label="Trạng thái đăng xuất Owner">'
  +'<h2>Đăng xuất chưa được xác nhận</h2>'
  +'<p class="project-error" role="alert">'+esc(error ||
    "Không xác minh được máy chủ đã kết thúc phiên Owner. Quyền sửa đang bị khóa.")+'</p>'
  +'<button type="button" class="btn" data-mpc-owner-logout-retry>Thử đăng xuất lại</button>'
  +'</section>';
 const logoutAction=(logoutAvailable===true||
   (session?.authenticated===true&&session?.login_enabled===true))
   ?'<div class="owner-request-actions"><button class="btn" type="button" data-mpc-owner-logout>Đăng xuất Owner</button></div>'
   :"";
 const target=selectedRequestTarget(catalogue,selected);
 if(!target)return '<section class="owner-request" aria-label="Gửi yêu cầu Owner">'
  +'<h2>Đề xuất chỉnh sửa</h2><p>Chọn một nhiệm vụ trong cây dự án để viết yêu cầu.</p>'
  +logoutAction+'</section>';
 const intro='<section class="owner-request" aria-label="Gửi yêu cầu Owner"><h2>Yêu cầu chỉnh sửa nhiệm vụ</h2>'
  +'<p class="owner-request-target">Đang chọn: <strong>'+esc(target.name)+'</strong></p>'
  +'<p class="mini">Yêu cầu chỉ được lưu để Owner xem xét. Không tự sửa SOT, giao việc hoặc bật Robot.</p>';
 const message=error?'<p class="project-error" role="alert">'+esc(error)+'</p>':"";
 const saved=session?.authenticated===true&&session?.login_enabled===true&&receipt?.request_id?'<p class="owner-request-receipt" role="status">'
  +'Đã ghi nhận yêu cầu #'+esc(receipt.request_id)+' · Chờ Owner xem xét. '
  +'Không kích hoạt robot hoặc thay đổi dữ liệu dự án.</p>':"";
 if(!session?.login_enabled) return intro+message+saved
  +'<p class="project-error" role="status">Chưa cấu hình phiên đăng nhập Owner hoặc kho lưu trữ riêng. Chỉ xem được, chưa thể gửi yêu cầu.</p></section>';
 if(!session?.authenticated) return intro+message+saved
  +'<form id="mpc-owner-login-form" autocomplete="off">'
  +'<label for="mpc-owner-password">Xác thực Owner trước khi gửi yêu cầu</label>'
  +'<input id="mpc-owner-password" name="password" type="password" autocomplete="current-password" required maxlength="256">'
  +'<button class="btn" type="submit">Đăng nhập Owner</button></form></section>';
 const desc=String(draft.description??"").slice(0,2500);
 const screens=String(draft.screenshots??"").slice(0,1000);
 const priorities=["LOW","NORMAL","HIGH"];
 const labels={LOW:"Thấp",NORMAL:"Bình thường",HIGH:"Cao"};
 const priority=priorities.includes(draft.priority)?draft.priority:"NORMAL";
 const options=priorities.map(v=>'<option value="'+v+'"'+(priority===v?" selected":"")+'>'
  +labels[v]+'</option>').join("");
 return intro+message+saved
  +'<form id="mpc-owner-request-form" data-target="'+esc(target.key)+'" autocomplete="off">'
  +'<label for="mpc-owner-description">Nội dung cần chỉnh sửa</label>'
  +'<textarea id="mpc-owner-description" name="description" minlength="20" maxlength="2500" rows="5" required'
  +' placeholder="Mô tả cần sửa gì và kết quả mong muốn...">'+esc(desc)+'</textarea>'
  +'<label for="mpc-owner-priority">Mức ưu tiên</label>'
  +'<select id="mpc-owner-priority" name="priority">'+options+'</select>'
  +'<label for="mpc-owner-screenshots">Đường dẫn ảnh minh họa (tối đa 3, mỗi dòng một URL)</label>'
  +'<textarea id="mpc-owner-screenshots" name="screenshots" rows="3" maxlength="1000"'
  +' placeholder="https://github.com/user-attachments/assets/...">'+esc(screens)+'</textarea>'
  +'<p class="mini">Chỉ nhận liên kết ảnh đính kèm GitHub. Chưa hỗ trợ tải trực tiếp ảnh lên Control Center.</p>'
  +'<div class="owner-request-actions"><button class="btn btn-good" type="submit">Gửi yêu cầu để xem xét</button></div>'
  +'</form>'+logoutAction+'</section>';
}
