import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {projectDetailProjection,resolveProjectSelection} from "../src/control-center/project_detail_projection.mjs";
import {renderProjectDetail} from "../src/control-center/web/project_detail_view.mjs";
import {renderProjectTree} from "../src/control-center/web/project_tree_view.mjs";

const SHA="a".repeat(40),OTHER="b".repeat(40),REPO="magasincoffee/magasin-supervisor";
const path="supervisor/project-control/MPC-005";
const source="SOURCE_OF_TRUTH.md";
const revision=(sha=SHA)=>({repo:REPO,path:source,sha,url:"https://github.com/"+REPO+"/blob/"+sha+"/"+source});
const navigation=()=>({status:"LOCAL_UNVERIFIED",projects:[
 {id:"supervisor",title:"Supervisor",sourceUrl:"https://github.com/"+REPO+"/blob/main/SOURCE_OF_TRUTH.md",features:[
   {id:"project-control",title:"MAGASIN PROJECT CONTROL",sourceUrl:"https://github.com/"+REPO+"/blob/main/docs/project-control/MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md",tasks:[
     {id:"MPC-005",title:"Chi tiết nhiệm vụ và bằng chứng",scopeStatus:"VERIFIED_DONE"}]}]},
 {id:"workforce",title:"MAGASIN Coffee",features:[]},
 {id:"print-ops",title:"MAGASIN CUP",features:[]}
]});
const ev=(kind,sha=SHA)=>({id:kind,kind,verified:true,revision:revision(sha),url:
 kind==="pr"?"https://github.com/"+REPO+"/pull/415":
 kind==="ci"?"https://github.com/"+REPO+"/actions/runs/38221516484":revision(sha).url});
const fullEvidence=["canonical_sot","task_dod","qa","exact_main","pr","ci"].map(x=>ev(x));
const canonical=(evidence=fullEvidence,extra={})=>({
 id:"supervisor",title:"Supervisor",revision:revision(),features:[{
   id:"project-control",title:"MPC",tasks:[{
     id:"MPC-005",title:"Chi tiết nhiệm vụ và bằng chứng",
     scopeStatus:"VERIFIED_DONE",ciStatus:"SUCCESS",releaseStatus:"NOT_RELEASED",
     transportStatus:"STOPPED",evidence,...extra
   }]
 }]
});
const snapshot=(x={})=>({ok:true,status:"CURRENT",
 source:{repo:REPO,path:source},revision:revision(),content:"# Canonical SOT",...x});
const project=(snapshotOverride=snapshot(),canonicalProject=canonical())=>projectDetailProjection({
 catalogue:navigation(),selected:path,authority:{snapshot:snapshotOverride,canonicalProject}
});
const read=name=>readFile(new URL("../"+name,import.meta.url),"utf8");

test("tree selections are exact, allowlisted and isolated between projects",()=>{
 const catalogue=navigation();
 assert.equal(resolveProjectSelection(catalogue,path).kind,"task");
 assert.equal(resolveProjectSelection(catalogue,"supervisor/project-control").kind,"feature");
 assert.equal(resolveProjectSelection(catalogue,"supervisor").kind,"project");
 for(const key of ["../../x","supervisor/project-control/MPC-005/extra","workforce/project-control/MPC-005",
 "print-ops/project-control/MPC-005","prototype/project-control/MPC-005","__proto__/x/y","supervisor//MPC-005"]){
   assert.equal(resolveProjectSelection(catalogue,key),null,key);
   assert.equal(projectDetailProjection({catalogue,selected:key}).status,"NOT_FOUND");
 }
});
test("local navigation claims VERIFIED_DONE without canonical proof remain UNKNOWN",()=>{
 const data=projectDetailProjection({catalogue:navigation(),selected:path});
 assert.equal(data.authority.scope,"UNKNOWN");
 assert.equal(data.authority.ci,"UNKNOWN");
 assert.equal(data.authority.transport,"UNKNOWN");
 const html=renderProjectDetail({catalogue:navigation(),selected:path});
 assert.match(html,/Chi tiết nhiệm vụ và bằng chứng/);
 assert.match(html,/Chưa xác minh/);
 assert.match(html,/Chưa xác minh SHA/);
 assert.match(html,/PR, CI và bằng chứng/);
 assert.doesNotMatch(html,/Hoàn thành đã xác minh/);
 assert.doesNotMatch(html,/>CI PASS</);
});
test("synthetic DoD evidence of four kinds and pinned revision qualifies only SOURCE completion",()=>{
 const data=project();
 assert.equal(data.authority.scope,"VERIFIED_DONE");
 assert.equal(data.authority.ci,"SUCCESS");
 assert.equal(data.authority.transport,"STOPPED");
 assert.equal(data.authority.release,"NOT_RELEASED");
 const html=renderProjectDetail({catalogue:navigation(),selected:path,detail:data});
 assert.match(html,/Hoàn thành đã xác minh/);
 assert.match(html,/CI PASS/);
 assert.match(html,/Đã dừng/);
 assert.match(html,/Chưa phát hành/);
 assert.match(html,/\/pull\/415/);
 assert.match(html,/\/actions\/runs\/38221516484/);
 assert.match(html,new RegExp(SHA));
});
test("one missing task DoD gate denies synthetic VERIFIED_DONE even with success CI",()=>{
 const missing=fullEvidence.filter(e=>e.kind!=="exact_main");
 const data=project(snapshot(),canonical(missing));
 assert.equal(data.authority.scope,"UNKNOWN");
 const html=renderProjectDetail({catalogue:navigation(),selected:path,detail:data});
 assert.doesNotMatch(html,/Hoàn thành đã xác minh/);
 assert.match(html,/CI PASS/); // CI is separate from task completion.
});
test("mismatched source/path or moved main never resolves to success",()=>{
 const mismatched=project(snapshot({revision:revision(OTHER)}));
 assert.equal(mismatched.authority.scope,"UNKNOWN");
 assert.equal(mismatched.authority.source,"CONFLICT");
 const moved=project(snapshot({ok:false,status:"MAIN_DIVERGED"}));
 assert.equal(moved.authority.scope,"UNKNOWN");
 assert.equal(moved.authority.source,"CONFLICT");
 assert.match(renderProjectDetail({catalogue:navigation(),selected:path,detail:moved}),/Xung đột nguồn/);
 const foreign=project(snapshot({source:{repo:"magasincoffee/OPS-WebApp",path:source}}));
 assert.equal(foreign.authority.source,"CONFLICT");
});
test("404, rate limit, stale and malformed source never fabricate statuses",()=>{
 for(const code of ["NOT_FOUND","RATE_LIMIT","STALE","ACCESS_DENIED","BAD_CONTENT","NETWORK_ERROR"]){
   const data=project(snapshot({ok:false,status:code}));
   assert.equal(data.authority.scope,"UNKNOWN");
   assert.equal(data.authority.ci,"UNKNOWN");
   assert.equal(data.authority.reason,code);
 }
 const bad=projectDetailProjection({catalogue:navigation(),selected:path,authority:{snapshot:{ok:true}}});
 assert.equal(bad.authority.scope,"UNKNOWN");
});
test("conflicting sources in MPC-002 evidence never resolve VERIFIED_DONE",()=>{
 const conflicting=canonical(fullEvidence,{claims:["BLOCKED"]});
 const data=project(snapshot(),conflicting);
 assert.equal(data.authority.scope,"CONFLICT");
 const html=renderProjectDetail({catalogue:navigation(),selected:path,detail:data});
 assert.match(html,/Xung đột nguồn/);
 assert.doesNotMatch(html,/Hoàn thành đã xác minh/);
});
test("cross-repository / hostile SOT and evidence URLs are never clickable",()=>{
 const cat=navigation();
 cat.projects[0].features[0].tasks[0].title='<svg onload="evil()">';
 cat.projects[0].features[0].tasks[0].sourceUrl="javascript:alert(1)";
 const html=renderProjectDetail({catalogue:cat,selected:path});
 assert.doesNotMatch(html,/<svg|href="javascript:|<script/);
 assert.match(html,/&lt;svg/);
 const wrong={...project(),authority:{...project().authority,evidence:[
 {id:"pr",kind:"pr",verified:true,sha:SHA,url:"https://github.com/magasincoffee/OPS-WebApp/pull/9"},
 {id:"ci",kind:"ci",verified:true,sha:SHA,url:"https://evil.example.org/a"}]}};
 const bad=renderProjectDetail({catalogue:navigation(),selected:path,detail:wrong});
 assert.doesNotMatch(bad,/OPS-WebApp\/pull\/9|evil.example/);
 assert.doesNotMatch(bad,/Hoàn thành đã xác minh/);
});
test("rendering selected tree includes detail and no owner mutation controls",()=>{
 const html=renderProjectTree({catalogue:navigation(),selected:path,expanded:["supervisor","supervisor/project-control"]});
 assert.match(html,/aria-label="Chi tiết mục đã chọn"/);
 assert.match(html,/Source of Truth|SOT của dự án/);
 assert.match(html,/Chưa xác minh SHA/);
 assert.doesNotMatch(html,/data-owner-start|data-owner-stop|method="POST"/);
});
test("browser route serves detail module, preserves mobile and existing robot controls",async()=>{
 const [server,view,app,style,doc]=await Promise.all([
 read("src/control-center/server.py"),read("src/control-center/web/project_tree_view.mjs"),
 read("src/control-center/web/app.js"),read("src/control-center/web/styles.css"),
 read("docs/project-control/MPC-005_READ_ONLY_DETAIL_HANDOFF_2026-10-12.md")]);
 assert.match(server,/if p=="\/project_detail_view\.mjs":/);
 assert.match(view,/import \{renderProjectDetail\} from "\.\/project_detail_view\.mjs"/);
 assert.match(view,/renderProjectDetail\(\{catalogue,selected\}\)/);
 assert.match(style,/@media\(max-width:500px\)/);
 assert.match(style,/grid-template-columns:minmax\(0,1fr\)/);
 assert.match(app,/\/api\/supervisor\/control/);
 assert.match(doc,/read-only/i);
 assert.doesNotMatch(server,/if p==="\/api\/projects\/write":/);
});

test("current status without pinned immutable URL or fetched content fails closed",()=>{
 const wrong=project(snapshot({revision:{...revision(),url:"https://github.com/"+REPO+"/blob/main/"+source}}));
 assert.equal(wrong.authority.source,"CONFLICT");
 const noBody=project(snapshot({content:null}));
 assert.equal(noBody.authority.source,"CONFLICT");
 const mismatchedCanonical=project(snapshot(),canonical(fullEvidence,{revision:revision(OTHER)}));
 assert.notEqual(mismatchedCanonical.authority.scope,"VERIFIED_DONE");
});
