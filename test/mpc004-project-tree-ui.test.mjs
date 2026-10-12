import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {renderProjectTree,projectTreeTrail} from "../src/control-center/web/project_tree_view.mjs";

const fixture=()=>({
 status:"LOCAL_UNVERIFIED",readOnly:true,projects:[
  {id:"supervisor",title:"Supervisor & Control Center",scopeStatus:"UNKNOWN",
   sourceUrl:"https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md",
   features:[{id:"project-control",title:"MAGASIN PROJECT CONTROL",scopeStatus:"UNKNOWN",
    sourceUrl:"https://github.com/magasincoffee/magasin-supervisor/blob/main/docs/project-control/MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md",
    tasks:[{id:"MPC-004",title:"Cây dự án và tìm kiếm",scopeStatus:"UNKNOWN"}]}]},
  {id:"workforce",title:"MAGASIN Coffee · Lịch làm việc",scopeStatus:"UNKNOWN",features:[]},
  {id:"print-ops",title:"MAGASIN CUP · OPS xưởng in",scopeStatus:"UNKNOWN",features:[]}
 ]
});
const read=(path)=>fs.readFile(new URL("../"+path,import.meta.url),"utf8");
test("MPC-004 renders project > feature > task with accessible expand/collapse and unknown statuses",()=>{
 const html=renderProjectTree({catalogue:fixture(),expanded:["supervisor","supervisor/project-control"]});
 assert.match(html,/data-project-toggle="supervisor"/);
 assert.match(html,/data-project-toggle="supervisor\/project-control"/);
 assert.match(html,/aria-expanded="true"/);
 assert.match(html,/data-project-focus="supervisor\/project-control\/MPC-004"/);
 assert.match(html,/MAGASIN Coffee/);
 assert.match(html,/MAGASIN CUP/);
 assert.match(html,/Chưa xác minh/);
 assert.doesNotMatch(html,/>Hoàn thành</);
 assert.doesNotMatch(html,/data-owner-start|data-owner-stop|data-project-write|method="POST"/);
});
test("closed parents hide children until opened, without losing source project",()=>{
 const html=renderProjectTree({catalogue:fixture(),expanded:[]});
 assert.match(html,/data-project-toggle="supervisor"/);
 assert.match(html,/aria-expanded="false"/);
 assert.doesNotMatch(html,/data-project-focus="supervisor\/project-control\/MPC-004"/);
});
test("case/accent-insensitive search keeps matching task and ancestors, excludes others",()=>{
 const html=renderProjectTree({catalogue:fixture(),query:"CAY DU AN",expanded:[]});
 assert.match(html,/MPC-004/);
 assert.match(html,/data-project-focus="supervisor"/);
 assert.doesNotMatch(html,/data-project-focus="workforce"/);
 const none=renderProjectTree({catalogue:fixture(),query:"nonsense-no-match"});
 assert.match(none,/Không tìm thấy mục phù hợp/);
});
test("breadcrumb follows selected project, feature and task",()=>{
 const path="supervisor/project-control/MPC-004";
 assert.deepEqual(projectTreeTrail(fixture(),path).map(x=>x.name),["Dự án","Supervisor & Control Center","MAGASIN PROJECT CONTROL","Cây dự án và tìm kiếm"]);
 const html=renderProjectTree({catalogue:fixture(),selected:path,expanded:["supervisor","supervisor/project-control"]});
 assert.match(html,/aria-label="Đường dẫn dự án"/);
 assert.match(html,/aria-current="page"/);
 assert.match(html,/https:\/\/github.com\/magasincoffee\/magasin-supervisor\/blob\/main\/docs\/project-control\/MPC_OWNER/);
});
test("hostile text and URLs never produce markup injection or external clickable links",()=>{
 const data=fixture();
 data.projects[0].title='<img src=x onerror="alert(1)">';
 data.projects[0].sourceUrl="javascript:alert(1)";
 data.projects[0].features[0].title='<svg onload="alert(2)">';
 data.projects[0].features[0].tasks[0].title='<script>alert(3)</script>';
 const html=renderProjectTree({catalogue:data,selected:"supervisor",expanded:["supervisor","supervisor/project-control"]});
 assert.doesNotMatch(html,/<script|<img|<svg|href="javascript:/);
 assert.match(html,/&lt;script&gt;/);
 assert.match(html,/&lt;img/);
 assert.match(html,/href="https:\\/\\/github\\.com\\/magasincoffee\\/magasin-supervisor\\/blob\\/main\\/SOURCE_OF_TRUTH\\.md"/);
 assert.doesNotMatch(html,/href="javascript:|href="https:\\/\\/(?!github\\.com\\/magasincoffee\\/magasin-supervisor\\/)/);
});
test("missing catalogue is clearly unavailable, never an empty completed projection",()=>{
 const html=renderProjectTree({catalogue:{status:"UNAVAILABLE",projects:[]}});
 assert.match(html,/Không đọc được danh mục dự án/);
 assert.match(html,/Chưa có dự án được xác minh/);
});
test("Control Center serves the actual shell, read-only API and module without replacing robot routes",async()=>{
 const [server,app,index,css,cat]=await Promise.all([
  read("src/control-center/server.py"),read("src/control-center/web/app.js"),
  read("src/control-center/web/index.html"),read("src/control-center/web/styles.css"),
  read("src/control-center/project_tree_catalogue.py")
 ]);
 for(const s of ['if p=="/api/projects":','if p in ("/","/index.html","/projects","/projects/")','if p=="/project_tree_view.mjs":'])
  assert.ok(server.includes(s),s);
 assert.match(server,/from project_tree_catalogue import read_only_project_catalogue/);
 assert.match(index,/<meta name="viewport" content="width=device-width,initial-scale=1">/);
 assert.match(index,/<script type="module" src="\/app.js"><\/script>/);
 for(const id of ["main-content","loading","page-title","page-subtitle","nav-robots","updated","refresh"])
  assert.match(index,new RegExp('id="'+id+'"'));
 assert.match(index,/data-page="projects"/);
 assert.match(app,/import \{renderProjectTree\} from "\.\/project_tree_view\.mjs"/);
 assert.match(app,/fetch\("\/api\/projects",\{cache:"no-store"\}\)/);
 assert.match(app,/location\.pathname==="\/projects"/);
 assert.match(app,/data-project-search|project-search/);
 assert.match(app,/data-project-toggle/);
 assert.match(app,/data-project-focus/);
 assert.match(app,/\/api\/supervisor\/project\/link/);
 assert.match(css,/@media\(max-width:840px\)/);
 assert.match(css,/@media\(max-width:430px\)/);
 assert.match(css,/grid-template-columns:240px minmax\(0,1fr\)/);
 assert.match(css, /min-width:0/);
 assert.match(cat,/scopeStatus": "UNKNOWN"/);
 assert.match(cat,/businessDispatchAllowed": False/);
 assert.doesNotMatch(cat,/"scopeStatus": "VERIFIED_DONE"|START_SUPERVISOR|os\.system|subprocess|urllib/);
});

test("overlapping robot refresh queues project loading and never treats null as no verified projects",async()=>{
 const app=await read("src/control-center/web/app.js");
 assert.match(app,/let refreshPending=false/);
 assert.match(app,/if\(busy\)\{refreshPending=true;return;\}/);
 assert.match(app,/if\(refreshPending\)\{refreshPending=false;void refresh\(\);\}/);
 const pending=renderProjectTree({catalogue:null});
 assert.match(pending,/Đang tải danh mục dự án/);
 assert.doesNotMatch(pending,/Chưa có dự án được xác minh/);
});

test("MPC-004 route races do not render stale project results over the current page",async()=>{
 const [app,server]=await Promise.all([read("src/control-center/web/app.js"),read("src/control-center/server.py")]);
 assert.match(app,/if\(currentPage\(\)==="projects"\)openPage\("projects",false\);\s*else refreshPending=true;/);
 assert.match(app,/const previousPage=currentPage\(\);\s*openPage\(button\.dataset\.open\);/);
 assert.match(app,/previousPage==="projects" \|\| !latest\)await refresh\(\)/);
 assert.match(server,/if p in \("\/","\/index\.html","\/projects","\/projects\/"\)/);
});
test("MPC-004 keyboard toggles restore focus to the matching replacement button",async()=>{
 const app=await read("src/control-center/web/app.js");
 assert.match(app,/root\.querySelectorAll\("\[data-project-toggle\]"\)/);
 assert.match(app,/x\.dataset\.projectToggle===key/);
 assert.match(app,/replacement\?\.focus\(\)/);
});

test("history popstate revalidates operational state and project selection preserves focus",async()=>{
 const app=await read("src/control-center/web/app.js");
 assert.match(app,/if\(page==="projects" \|\| latest\)\{openPage\(page,false\);announceNavigation\(\);\}/);
 assert.match(app,/History traversal always revalidates the destination status/);
 assert.match(app,/void refresh\(\);\s*\}\);\s*setInterval/);
 assert.match(app,/dataset\.projectFocus===key/);
 assert.match(app,/\(replacement\|\|root\.querySelector\("#project-search"\)\)\?\.focus\(\)/);
});

test("MPC-004 polling preserves tree toggle, row and search keyboard focus",async()=>{
 const [app,index]=await Promise.all([read("src/control-center/web/app.js"),read("src/control-center/web/index.html")]);
 assert.match(app,/function captureProjectFocus\(\)/);
 assert.match(app,/function restoreProjectFocus\(saved\)/);
 assert.match(app,/root\.contains\(active\)/);
 assert.match(app,/active\.id==="project-search"/);
 assert.match(app,/active\.dataset\?\.projectToggle!==undefined/);
 assert.match(app,/active\.dataset\?\.projectFocus!==undefined/);
 assert.match(app,/const previousProjectFocus=page==="projects"\?captureProjectFocus\(\):null/);
 assert.match(app,/restoreProjectFocus\(previousProjectFocus\)/);
 assert.match(app,/target\.focus\(\{preventScroll:true\}\)/);
 assert.match(app,/target\.setSelectionRange\(/);
 assert.match(index,/<main id="main-content" tabindex="-1"><\/main>/);
 assert.doesNotMatch(index,/<main[^>]*aria-live/);
 assert.match(index,/<p id="loading"[^>]*role="status"/);
});

test("MPC-004 announces explicit client route changes without announcing each poll rerender",async()=>{
 const [app,html,css]=await Promise.all([read("src/control-center/web/app.js"),read("src/control-center/web/index.html"),read("src/control-center/web/styles.css")]);
 assert.match(html,/<main id="main-content" tabindex="-1"><\/main>/);
 assert.doesNotMatch(html,/<main[^>]*aria-live/);
 assert.match(html,/<p id="page-navigation-status"[^>]*role="status"[^>]*aria-live="polite"/);
 assert.match(css,/\.sr-only\{/);
 assert.match(app,/const navigationStatus=document\.getElementById\("page-navigation-status"\)/);
 assert.match(app,/function announceNavigation\(\)/);
 assert.match(app,/navigationStatus\.textContent="Đã mở trang: "\+nameTitle\.textContent/);
 assert.match(app,/if\(historyUpdate\)\{announceNavigation\(\);window\.scrollTo/);
 assert.match(app,/if\(page==="projects" \|\| latest\)\{openPage\(page,false\);announceNavigation\(\);\}/);
 assert.doesNotMatch(app,/if\(currentPage\(\)==="projects"\)\{?announceNavigation/);
});
