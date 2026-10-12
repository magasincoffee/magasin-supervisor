// MPC-005: pure read-only detail truth projection. Input authority must be
// supplied by a trusted server adapter; never use the navigation catalogue as proof.
import {buildProjectReadModel} from "./project_read_model.mjs";
import {APPROVED_SOT_SOURCES} from "./project_sot_adapter.mjs";

const SHA=/^[a-f0-9]{40}$/;
const IDENT=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const record=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const isKey=x=>typeof x==="string"&&x.length<=250&&x.split("/").length<=3&&x.split("/").every(s=>IDENT.test(s));
const MODEL_BEGIN="<!-- MAGASIN_CANONICAL_PROJECT_MODEL_V1_BEGIN -->";
const MODEL_END="<!-- MAGASIN_CANONICAL_PROJECT_MODEL_V1_END -->";
// The model must be DERIVED from the exact immutable SOT bytes returned by
// MPC-003, not supplied independently by a caller with copied revision fields.
// Legacy Markdown without this explicit machine-readable section has no
// trustworthy task-status projection and therefore remains UNKNOWN.
function modelFromSot(content){
 if(typeof content!=="string")return null;
 const start=content.indexOf(MODEL_BEGIN);
 if(start<0||content.indexOf(MODEL_BEGIN,start+MODEL_BEGIN.length)!==-1)return null;
 const first=start+MODEL_BEGIN.length;
 if(content[first]!=="\n")return null;
 const end=content.indexOf("\n"+MODEL_END,first+1);
 if(end<0||content.indexOf(MODEL_END,end+1+MODEL_END.length)!==-1)return null;
 const data=content.slice(first+1,end);
 if(data.length===0||data.length>131072)return null;
 try{
   const parsed=JSON.parse(data);
   return record(parsed)&&parsed.schema==="magasin-canonical-project-model.v1"&&
     record(parsed.project)?parsed.project:null;
 }catch{return null;}
}

// SOT content cannot encode its own final commit hash. Structured authoring
// records therefore contain NO revision/SHA field: attach the verified adapter
// revision after the immutable snapshot was read. Any embedded attempt to
// declare an independent revision fails closed, including nested evidence.
function bindSnapshotRevision(input,revision){
 const proofBound=new Set(["canonical_sot","task_dod","qa","exact_main"]);
 const node=n=>{
   if(!record(n)||Object.hasOwn(n,"revision"))throw new Error("EMBEDDED_NODE_REVISION");
   const out={...n,revision:{...revision}};
   if(Array.isArray(n.evidence))out.evidence=n.evidence.map(e=>{
     if(!record(e)||Object.hasOwn(e,"revision"))throw new Error("EMBEDDED_EVIDENCE_REVISION");
     return {...e,revision:{...revision},url:proofBound.has(e.kind)&&e.url===undefined?revision.url:e.url};
   });
   if(Array.isArray(n.features))out.features=n.features.map(node);
   if(Array.isArray(n.tasks))out.tasks=n.tasks.map(node);
   return out;
 };
 return node(input);
}
export function resolveProjectSelection(catalogue,selected){
 if(!isKey(selected)||!record(catalogue)||!Array.isArray(catalogue.projects))return null;
 const ids=selected.split("/");
 const project=catalogue.projects.find(p=>record(p)&&p.id===ids[0]);
 const sourceId=project?.id==="print-ops"?"print_ops":project?.id;
 if(!project||!Object.hasOwn(APPROVED_SOT_SOURCES,sourceId))return null;
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
 const snap=authority.snapshot;
 const sourceId=chosen.projectId==="print-ops"?"print_ops":chosen.projectId;
 const source=APPROVED_SOT_SOURCES[sourceId];
 if(snap.ok!==true||snap.status!=="CURRENT")return fail(
   snap.status==="MAIN_DIVERGED"||snap.status==="CONFLICT"?"CONFLICT":"UNVERIFIED",
   typeof snap.status==="string"?snap.status:"UNAVAILABLE");
 if(!record(snap.source)||snap.source.repo!==source.repo||snap.source.path!==source.path||
   !record(snap.revision)||snap.revision.repo!==source.repo||snap.revision.path!==source.path||
   typeof snap.revision.sha!=="string"||!SHA.test(snap.revision.sha)||
   snap.revision.url!=="https://github.com/"+source.repo+"/blob/"+snap.revision.sha+"/"+source.path||
   typeof snap.content!=="string")return fail("CONFLICT","SOURCE_REVISION_MISMATCH");
 // A separately passed canonicalProject cannot prove anything. Only a
 // structured model INSIDE the fetched immutable source is allowed to supply
 // statuses. Missing, malformed or duplicate markers fail closed.
 const modelInSot=modelFromSot(snap.content);
 if(!modelInSot)return fail("UNVERIFIED","CANONICAL_MODEL_NOT_BOUND_TO_SOT");
 let canonical;
 try {canonical=bindSnapshotRevision(modelInSot,snap.revision);}
 catch {return fail("CONFLICT","EMBEDDED_SOURCE_REVISION_FORBIDDEN");}
 if(canonical.id!==chosen.projectId||!record(canonical.revision)||
   canonical.revision.sha!==snap.revision.sha||canonical.revision.url!==snap.revision.url||
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
 const pinned="https://github.com/"+source.repo+"/blob/"+snap.revision.sha+"/"+source.path;
 // Never substitute the mutable /blob/main URL for the exact reviewed SHA.
 if(revision.repo!==source.repo||revision.path!==source.path||
    revision.sha!==snap.revision.sha||revision.url!==pinned)
   return fail("CONFLICT","NODE_REVISION_DIVERGED");
 const revisionBound=new Set(["canonical_sot","task_dod","qa","exact_main"]);
 if(node.evidence.some(e=>e.revision.repo!==source.repo||e.revision.path!==source.path||
   e.revision.sha!==snap.revision.sha||e.revision.url!==pinned||
   (revisionBound.has(e.kind)&&e.url!==pinned)))
   return fail("CONFLICT","EVIDENCE_REVISION_DIVERGED");
 const evidence=node.evidence.map(e=>({
   id:e.id,kind:e.kind,verified:e.verified,
   url:e.url,sha:e.revision.sha
 }));
 return {...result,authority:{scope:node.scopeStatus,transport:node.transportStatus,ci:node.ciStatus,
   release:node.releaseStatus,source:"CANONICAL_MODEL",reason:"VERIFIED_MODEL_PROJECTION",
   revision:{repo:revision.repo,path:revision.path,sha:revision.sha,url:revision.url},
   evidence}};
}
