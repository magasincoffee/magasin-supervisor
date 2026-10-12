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
const authorable=p=>{
 const copy=JSON.parse(JSON.stringify(p));
 const known=JSON.stringify(revision());
 const bound=new Set(["canonical_sot","task_dod","qa","exact_main"]);
 const clean=n=>{
   // Legitimate SOT authoring never includes its own unrecoverable commit SHA.
   // Preserve intentionally foreign revision fixtures to assert fail-closed.
   if(JSON.stringify(n.revision)===known)delete n.revision;
   for(const e of n.evidence??[]){
     if(JSON.stringify(e.revision)===known)delete e.revision;
     if(bound.has(e.kind)&&e.url===revision().url)delete e.url;
   }
   for(const child of n.features??[])clean(child);
   for(const child of n.tasks??[])clean(child);
 };
 clean(copy);
 return copy;
};
const embedModel=p=>"# Canonical SOT\n<!-- MAGASIN_CANONICAL_PROJECT_MODEL_V1_BEGIN -->\n"+
 JSON.stringify({schema:"magasin-canonical-project-model.v1",project:authorable(p)})+
 "\n<!-- MAGASIN_CANONICAL_PROJECT_MODEL_V1_END -->\n";
const snapshot=(x={})=>({ok:true,status:"CURRENT",
 source:{repo:REPO,path:source},revision:revision(),content:"# Canonical SOT",...x});
const project=(snapshotOverride=snapshot(),canonicalProject=canonical())=>{
 // Positive fixture: the model is INSIDE the fetched SOT bytes. A caller
 // passing canonicalProject alone cannot promote a status to VERIFIED_DONE.
 const snap=snapshotOverride.content==="# Canonical SOT"?
   {...snapshotOverride,content:embedModel(canonicalProject)}:snapshotOverride;
 return projectDetailProjection({catalogue:navigation(),selected:path,
   authority:{snapshot:snap,canonicalProject}});
};
const read=name=>readFile(new URL("../"+name,import.meta.url),"utf8");

test("tree selections are exact, allowlisted and isolated between projects",()=>{
 const catalogue=navigation();
 assert.equal(resolveProjectSelection(catalogue,path).kind,"task");
 assert.equal(resolveProjectSelection(catalogue,"supervisor/project-control").kind,"feature");
 assert.equal(resolveProjectSelection(catalogue,"supervisor").kind,"project");
 assert.equal(resolveProjectSelection(catalogue,"print-ops").kind,"project");
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

test("stale task SHA B cannot be VERIFIED_DONE against CURRENT canonical SHA A",()=>{
 const otherProof=["canonical_sot","task_dod","qa","exact_main"].map(kind=>ev(kind,OTHER));
 const data=project(snapshot(),canonical(otherProof,{revision:revision(OTHER)}));
 assert.equal(data.authority.source,"CONFLICT");
 assert.equal(data.authority.scope,"UNKNOWN");
});
test("revision-bound evidence at blob/main never authorizes immutable DoD",()=>{
 const mutableUrl="https://github.com/"+REPO+"/blob/main/"+source;
 const fake=fullEvidence.map(e=>({
   ...e,revision:{...e.revision,url:mutableUrl},
   url:["canonical_sot","task_dod","qa","exact_main"].includes(e.kind)?mutableUrl:e.url
 }));
 const data=project(snapshot(),canonical(fake));
 assert.equal(data.authority.source,"CONFLICT");
 assert.equal(data.authority.scope,"UNKNOWN");
 const forged={...project(),authority:{...project().authority,evidence:fake.map(e=>({
   id:e.id,kind:e.kind,verified:true,sha:SHA,url:e.url
 })),revision:{...revision(),url:mutableUrl}}};
 assert.doesNotMatch(renderProjectDetail({catalogue:navigation(),selected:path,detail:forged}),/Hoàn thành đã xác minh/);
});

test("display-only forged same-repo wrong SOT path never becomes VERIFIED_DONE",()=>{
 const valid=project();
 const badPath="docs/OTHER_DOCUMENT.md";
 const wrongRevision={...valid.authority.revision,path:badPath,url:"https://github.com/"+REPO+"/blob/"+SHA+"/"+badPath};
 const kinds=["canonical_sot","task_dod","qa","exact_main"];
 const forged={...valid,authority:{...valid.authority,revision:wrongRevision,evidence:[
   ...kinds.map(kind=>({id:kind,kind,verified:true,sha:SHA,url:wrongRevision.url})),
   {id:"ci",kind:"ci",verified:true,sha:SHA,url:"https://github.com/"+REPO+"/actions/runs/38221516484"}
 ]}};
 const html=renderProjectDetail({catalogue:navigation(),selected:path,detail:forged});
 assert.doesNotMatch(html,/Hoàn thành đã xác minh/);
 assert.doesNotMatch(html,/OTHER_DOCUMENT/);
 assert.match(html,/Chưa xác minh/);
});

test("mutable authority URL rejects all claimed statuses, not only VERIFIED_DONE",()=>{
 const valid=project();
 const mutable="https://github.com/"+REPO+"/blob/main/"+source;
 for(const scope of ["READY","IN_PROGRESS","VERIFIED_DONE"]){
   const forged={...valid,authority:{...valid.authority,scope,transport:"RUNNING",ci:"SUCCESS",release:"ACCEPTED",revision:{...revision(),url:mutable}}};
   const html=renderProjectDetail({catalogue:navigation(),selected:path,detail:forged});
   assert.match(html,/Chưa xác minh/);
   assert.doesNotMatch(html,/>CI PASS|>Đang chạy|>Đã được chấp thuận|>Sẵn sàng|>Đang thực hiện|>Hoàn thành đã xác minh/);
   assert.match(html,/Chưa xác minh SHA/);
 }
});

test("pinned SOT Markdown without embedded authoritative model cannot claim task status",()=>{
 const fake=canonical(fullEvidence);
 const data=project(snapshot({content:"# Canonical SOT\nMPC-005 is VERIFIED_DONE with four proofs."}),fake);
 assert.equal(data.authority.source,"UNVERIFIED");
 assert.equal(data.authority.scope,"UNKNOWN");
 assert.equal(data.authority.ci,"UNKNOWN");
 assert.doesNotMatch(renderProjectDetail({catalogue:navigation(),selected:path,detail:data}),/>CI PASS|Hoàn thành đã xác minh/);
});

test("caller-provided fabricated or stale canonicalProject cannot override SOT model bytes",()=>{
 const real=canonical([], {scopeStatus:"BLOCKED",ciStatus:"FAILURE",transportStatus:"STOPPED"});
 const snapshotSource=snapshot({content:embedModel(real)});
 const forged=projectDetailProjection({catalogue:navigation(),selected:path,
   authority:{snapshot:snapshotSource,canonicalProject:canonical(fullEvidence)}});
 assert.equal(forged.authority.source,"CANONICAL_MODEL");
 assert.equal(forged.authority.scope,"BLOCKED");
 assert.equal(forged.authority.ci,"FAILURE");
 assert.notEqual(forged.authority.scope,"VERIFIED_DONE");
 const missing=canonical(fullEvidence.filter(e=>e.kind!=="task_dod"));
 const alsoForged=projectDetailProjection({catalogue:navigation(),selected:path,
   authority:{snapshot:snapshot({content:embedModel(missing)}),canonicalProject:canonical(fullEvidence)}});
 assert.equal(alsoForged.authority.scope,"UNKNOWN");
});

test("malformed, duplicate, and oversized SOT project-model markers fail closed",()=>{
 const valid=embedModel(canonical());
 const cases=[valid+valid,
   "# SOT\n<!-- MAGASIN_CANONICAL_PROJECT_MODEL_V1_BEGIN -->\nnot-json\n<!-- MAGASIN_CANONICAL_PROJECT_MODEL_V1_END -->",
   "# SOT\n<!-- MAGASIN_CANONICAL_PROJECT_MODEL_V1_BEGIN -->\n"+
      "x".repeat(131073)+"\n<!-- MAGASIN_CANONICAL_PROJECT_MODEL_V1_END -->"];
 for(const content of cases){
   const data=project(snapshot({content}));
   assert.equal(data.authority.scope,"UNKNOWN");
   assert.equal(data.authority.ci,"UNKNOWN");
   assert.equal(data.authority.source,"UNVERIFIED");
 }
});

test("canonical project SOT and subordinate plan are visibly different links",()=>{
 const html=renderProjectDetail({catalogue:navigation(),selected:path});
 assert.match(html,/SOT chuẩn của dự án \(liên kết điều hướng\)/);
 assert.match(html,/https:\/\/github.com\/magasincoffee\/magasin-supervisor\/blob\/main\/SOURCE_OF_TRUTH.md/);
 assert.match(html,/Tài liệu mô tả mục \(chỉ tham khảo, không phải SOT\)/);
 assert.match(html,/docs\/project-control\/MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md/);
 assert.doesNotMatch(html,/SOT của dự án: <a[^>]*MPC_OWNER_ARCHITECTURE/);
});

test("authorable SOT model has no self-referential SHA; adapter supplies revision",()=>{
 const raw=embedModel(canonical());
 assert.doesNotMatch(raw,/"sha":|"revision":/);
 const data=project(snapshot({content:raw}));
 assert.equal(data.authority.source,"CANONICAL_MODEL");
 assert.equal(data.authority.revision.sha,SHA);
 assert.equal(data.authority.scope,"VERIFIED_DONE");
 const illegal={...authorable(canonical()),revision:revision()};
 const poison="# Canonical SOT\n<!-- MAGASIN_CANONICAL_PROJECT_MODEL_V1_BEGIN -->\n"+
   JSON.stringify({schema:"magasin-canonical-project-model.v1",project:illegal})+
   "\n<!-- MAGASIN_CANONICAL_PROJECT_MODEL_V1_END -->\n";
 const rejected=project(snapshot({content:poison}));
 assert.equal(rejected.authority.source,"CONFLICT");
 assert.equal(rejected.authority.scope,"UNKNOWN");
});
