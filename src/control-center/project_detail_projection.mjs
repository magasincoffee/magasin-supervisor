// MPC-005: pure read-only detail truth projection. Input authority must be
// supplied by a trusted server adapter; never use the navigation catalogue as proof.
import {buildProjectReadModel} from "./project_read_model.mjs";
import {APPROVED_SOT_SOURCES} from "./project_sot_adapter.mjs";

const SHA=/^[a-f0-9]{40}$/;
const IDENT=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const record=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const isKey=x=>typeof x==="string"&&x.length<=250&&x.split("/").length<=3&&x.split("/").every(s=>IDENT.test(s));
export function resolveProjectSelection(catalogue,selected){
 if(!isKey(selected)||!record(catalogue)||!Array.isArray(catalogue.projects))return null;
 const ids=selected.split("/");
 const project=catalogue.projects.find(p=>record(p)&&p.id===ids[0]);
 if(!project||!Object.hasOwn(APPROVED_SOT_SOURCES,project.id))return null;
 const feature=ids.length>1&&Array.isArray(project.features)?project.features.find(f=>record(f)&&f.id===ids[1]):null;
 if(ids.length>1&&!feature)return null;
 const task=ids.length>2&&Array.isArray(feature?.tasks)?feature.tasks.find(t=>record(t)&&t.id===ids[2]):null;
 if(ids.length>2&&!task)return null;
 const current=task??feature??project;
 return {projectId:project.id,selected,key:selected,kind:task?"task":feature?"feature":"project",
   id:current.id,title:current.title,sourceUrl:current.sourceUrl??feature?.sourceUrl??project.sourceUrl??null};
}
const blank=()=>({scope:"UNKNOWN",transport:"UNKNOWN",ci:"UNKNOWN",release:"UNKNOWN",
  revision:null,evidence:[],source:"UNVERIFIED",reason:"CANONICAL_EVIDENCE_MISSING"});
export function projectDetailProjection({catalogue,selected,authority=null}={}){
 const chosen=resolveProjectSelection(catalogue,selected);
 if(!chosen)return {ok:false,status:"NOT_FOUND",selected:null};
 const result={ok:true,selected:chosen,readOnly:true,authority:blank()};
 // Navigation metadata and a CLOSED PR are never independent task evidence.
 if(authority==null)return result;
 const fail=(source,reason)=>({...result,authority:{...blank(),source,reason}});
 if(!record(authority)||!record(authority.snapshot))return fail("UNVERIFIED","MALFORMED_AUTHORITY");
 const snap=authority.snapshot, source=APPROVED_SOT_SOURCES[chosen.projectId];
 if(snap.ok!==true||snap.status!=="CURRENT")return fail(
   snap.status==="MAIN_DIVERGED"||snap.status==="CONFLICT"?"CONFLICT":"UNVERIFIED",
   typeof snap.status==="string"?snap.status:"UNAVAILABLE");
 if(!record(snap.source)||snap.source.repo!==source.repo||snap.source.path!==source.path||
   !record(snap.revision)||snap.revision.repo!==source.repo||snap.revision.path!==source.path||
   typeof snap.revision.sha!=="string"||!SHA.test(snap.revision.sha)||
   !record(authority.canonicalProject))return fail("CONFLICT","SOURCE_REVISION_MISMATCH");
 // The canonical SOT of the project is not necessarily the subordinate
 // project's feature/task SOT: both boundaries must agree, or fail closed.
 const canonical=authority.canonicalProject;
 if(canonical.id!==chosen.projectId||!record(canonical.revision)||
   canonical.revision.sha!==snap.revision.sha||
   canonical.revision.repo!==source.repo||canonical.revision.path!==source.path)return fail("CONFLICT","PROJECT_REVISION_MISMATCH");
 let node;
 try{
   const model=buildProjectReadModel([canonical]);
   const project=model.projects[0];
   node=project.nodes.find(n=>n.id===chosen.id&&n.type===chosen.kind &&
     n.parentId===(chosen.kind==="task"?selected.split("/")[1]:chosen.kind==="feature"?chosen.projectId:null));
 }catch{return fail("CONFLICT","MODEL_REJECTED");}
 if(!node)return fail("UNVERIFIED","TASK_NOT_INDEXED_IN_CANONICAL_SOT");
 // Even CURRENT GitHub SOT text is not a verified DoD: the MPC-002 schema
 // validates all evidence and degrades unsupported VERIFIED_DONE to UNKNOWN.
 const revision=node.revision;
 const evidence=node.evidence.map(e=>({
   id:e.id,kind:e.kind,verified:e.verified,
   url:e.url,sha:e.revision.sha
 }));
 return {...result,authority:{scope:node.scopeStatus,transport:node.transportStatus,ci:node.ciStatus,
   release:node.releaseStatus,source:"CANONICAL_MODEL",reason:"VERIFIED_MODEL_PROJECTION",
   revision:{repo:revision.repo,path:revision.path,sha:revision.sha,url:revision.url},
   evidence}};
}
