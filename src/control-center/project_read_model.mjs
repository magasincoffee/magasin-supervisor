// MPC-002: pure, read-only projection. No GitHub I/O, persistence or dispatcher.
export const SCOPE_STATES = Object.freeze(["PLANNED","READY","IN_PROGRESS","BLOCKED","WAITING_OWNER","VERIFIED_DONE","UNKNOWN","CONFLICT"]);
export const TRANSPORT_STATES = Object.freeze(["UNKNOWN","STOPPED","RUNNING","WAITING","ERROR"]);
export const CI_STATES = Object.freeze(["UNKNOWN","QUEUED","IN_PROGRESS","SUCCESS","FAILURE","CANCELLED"]);
export const RELEASE_STATES = Object.freeze(["UNKNOWN","NOT_RELEASED","AWAITING_OWNER","ACCEPTED","REJECTED"]);
const SHA = /^[0-9a-f]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const isObj = x => x !== null && typeof x === "object" && !Array.isArray(x);
const required = (ok, message) => { if (!ok) throw new TypeError(message); };
const blobUrl = url => typeof url === "string" && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/blob\/[A-Za-z0-9_.\/-]+$/.test(url);
const evidenceUrl = (url,kind) => {
  if(typeof url !== "string") return false;
  const base = "^https:\\/\\/github\\.com\\/[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+\\/";
  const suffix = kind==="pr" ? "pull\\/[1-9][0-9]*" :
    kind==="ci" ? "actions\\/runs\\/[1-9][0-9]*" :
    kind==="owner_acceptance" ? "(?:issues\\/[1-9][0-9]*|pull\\/[1-9][0-9]*|blob\\/[A-Za-z0-9_.\\/-]+)" :
    "blob\\/[A-Za-z0-9_.\\/-]+";
  return new RegExp(base+suffix+"$").test(url);
};
function revision(x) {
  required(isObj(x) && typeof x.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(x.repo), "revision.repo");
  required(typeof x.path === "string" && x.path.length > 0 && !x.path.includes(".."), "revision.path");
  required(typeof x.sha === "string" && SHA.test(x.sha), "revision.sha must be immutable commit SHA");
  required(blobUrl(x.url), "revision.url");
  // Parse the entire blob path: suffix matching can accept docs/SOURCE_OF_TRUTH.md.
  // Only plain main or the exact immutable snapshot SHA may identify the ref.
  const prefix="https://github.com/"+x.repo+"/blob/";
  const suffix=x.url.startsWith(prefix) ? x.url.slice(prefix.length) : "";
  const at=suffix.indexOf("/");
  const ref=at<0 ? "" : suffix.slice(0,at);
  const blobPath=at<0 ? "" : suffix.slice(at+1);
  required((ref==="main" || ref===x.sha) && blobPath===x.path, "revision.url must match repo/path");
  return {repo:x.repo,path:x.path,sha:x.sha,url:x.url};
}
function evidence(x) {
  required(isObj(x) && typeof x.id === "string" && ID.test(x.id), "evidence.id");
  required(["canonical_sot","task_dod","qa","pr","ci","exact_main","owner_acceptance"].includes(x.kind), "evidence.kind");
  required(typeof x.verified === "boolean", "evidence.verified");
  required(isObj(x.revision) && typeof x.revision.sha === "string" && SHA.test(x.revision.sha), "evidence.revision");
  required(evidenceUrl(x.url,x.kind), "evidence.url");
  const eRev=revision(x.revision);
  required(x.url.startsWith("https://github.com/"+eRev.repo+"/"), "evidence.url repo mismatch");
  if(["canonical_sot","task_dod","qa","exact_main"].includes(x.kind)) required(x.url===eRev.url, "evidence.url revision mismatch");
  return {id:x.id,kind:x.kind,verified:x.verified,revision:revision(x.revision),url:x.url};
}
const state = (value,values) => values.includes(value) ? value : "UNKNOWN";
function item(x,type,parentId,projectRevision) {
  required(isObj(x) && typeof x.id === "string" && ID.test(x.id), type+".id");
  required(typeof x.title === "string" && x.title.trim().length > 0 && x.title.length <= 200,type+".title");
  required(x.evidence===undefined || Array.isArray(x.evidence),type+".evidence");
  const proof=(x.evidence??[]).map(evidence);
  const snapshot=x.revision === undefined ? projectRevision : revision(x.revision);
  const sourceBoundary=snapshot.repo===projectRevision.repo && snapshot.path===projectRevision.path;
  const sameSource=sourceBoundary && proof.every(e=>e.revision.repo===snapshot.repo && e.revision.path===snapshot.path);
  const divergent=proof.some(e=>e.kind==="canonical_sot" && e.verified && e.revision.sha!==snapshot.sha);
  const scope=state(x.scopeStatus,SCOPE_STATES);
  const verifiedKinds=new Set(proof.filter(e=>e.verified && e.revision.sha===snapshot.sha).map(e=>e.kind));
  const hasDoD=verifiedKinds.has("canonical_sot") && verifiedKinds.has("task_dod") && verifiedKinds.has("qa") && verifiedKinds.has("exact_main");
  required(x.claims===undefined || Array.isArray(x.claims),type+".claims");
  const malformedClaims=Array.isArray(x.claims) && x.claims.some(s=>typeof s!=="string" || !SCOPE_STATES.includes(s));
  const hasConflictingClaims=Array.isArray(x.claims) && new Set([scope,...x.claims].filter(s=>s!=="UNKNOWN")).size>1;
  const resolved=malformedClaims ? "UNKNOWN" : (divergent || hasConflictingClaims || !sameSource) ? "CONFLICT" : scope==="VERIFIED_DONE" && !hasDoD ? "UNKNOWN" : scope;
  return {id:x.id,title:x.title,type,parentId,revision:snapshot,evidence:proof,scopeStatus:resolved,transportStatus:state(x.transportStatus,TRANSPORT_STATES),ciStatus:state(x.ciStatus,CI_STATES),releaseStatus:state(x.releaseStatus,RELEASE_STATES)};
}
export function buildProjectReadModel(projects) {
  required(Array.isArray(projects), "projects must be array");
  const ids=new Set();
  const output=projects.map(p=>{
    required(isObj(p) && typeof p.id === "string" && ID.test(p.id), "project.id");
    const rev=revision(p.revision);
    const nodes=[];
    const add=(x,type,parent) => {const node=item(x,type,parent,rev); const key=p.id+":"+type+":"+node.id;required(!ids.has(key),"duplicate node");ids.add(key);nodes.push(node);return node;};
    const root=add(p,"project",null);
    required(p.features===undefined || Array.isArray(p.features),"project.features");
    for(const f of (p.features??[])){
      const feature=add(f,"feature",root.id);
      required(f.tasks===undefined || Array.isArray(f.tasks),"feature.tasks");
      for(const t of (f.tasks??[])) add(t,"task",feature.id);
    }
    return {id:root.id,repository:rev.repo,revision:rev,nodes};
  });
  return {schemaVersion:"magasin-project-read-model.v1",projects:output};
}
