// MPC-003: server-side, fail-closed, read-only GitHub SOT adapter.
// No routes, dispatch, project switching, mutation, or implied completion state.
export const APPROVED_SOT_SOURCES = Object.freeze({
  supervisor: Object.freeze({repo:"magasincoffee/magasin-supervisor",path:"SOURCE_OF_TRUTH.md"}),
  workforce: Object.freeze({repo:"magasincoffee/magasincoffee.github.io",path:"01_DOCS/MAGASIN/05_SYSTEM/WORKFORCE_CROSS_STORE_SCHEDULING_TEMP_SOURCE_OF_TRUTH.md"}),
  print_ops: Object.freeze({repo:"magasincoffee/OPS-WebApp",path:"SOURCE_OF_TRUTH.md"})
});
const SHA=/^[0-9a-f]{40}$/;
const isObject=x=>x!==null && typeof x==="object" && !Array.isArray(x);
class ReadFailure extends Error {
  constructor(code) { super(code); this.code=code; }
}
function ensure(ok,code) { if(!ok) throw new ReadFailure(code); }
function decodeFile(result,maxBytes) {
  ensure(isObject(result) && result.type==="file" && result.encoding==="base64" && typeof result.content==="string","BAD_CONTENT");
  const encoded=result.content.replace(/\s/g,"");
  ensure(encoded.length>0 && encoded.length<=Math.ceil(maxBytes/3)*4+4 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded),"BAD_CONTENT");
  const bytes=Buffer.from(encoded,"base64");
  ensure(bytes.length>0 && bytes.length<=maxBytes && bytes.toString("base64")===encoded,"BAD_CONTENT");
  // Fatal decoding prevents replacement characters from rewriting pinned SOT bytes.
  try { return new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes); }
  catch { throw new ReadFailure("BAD_CONTENT"); }
}
// Each consumer gets a separate projection. Neither the first response nor a
// cache hit can mutate the adapter's cached authority snapshot.
const copySnapshot = (snapshot,fromCache) => ({
  ...snapshot,
  source:{...snapshot.source},
  revision:{...snapshot.revision},
  fromCache
});
export function createReadOnlySotAdapter({
  fetchImpl=globalThis.fetch, now=()=>Date.now(),
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  token, cacheTtlMs=30000, timeoutMs=7000, maxRetries=2, maxBytes=512000
}={}) {
  ensure(typeof fetchImpl==="function" && typeof now==="function" && typeof sleep==="function","BAD_CONFIGURATION");
  ensure(Number.isInteger(cacheTtlMs) && cacheTtlMs>=0 && cacheTtlMs<=300000,"BAD_CONFIGURATION");
  ensure(Number.isInteger(timeoutMs) && timeoutMs>=100 && timeoutMs<=15000,"BAD_CONFIGURATION");
  ensure(Number.isInteger(maxRetries) && maxRetries>=0 && maxRetries<=2,"BAD_CONFIGURATION");
  ensure(Number.isInteger(maxBytes) && maxBytes>=1024 && maxBytes<=1048576,"BAD_CONFIGURATION");
  ensure(token===undefined || (typeof token==="string" && token.length>0 && token.length<=4096),"BAD_CONFIGURATION");
  const cached=new Map();
  async function getJson(url) {
    for(let attempt=0;attempt<=maxRetries;attempt++) {
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),timeoutMs);
      try {
        const headers={Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"};
        if(token!==undefined) headers.Authorization="Bearer "+token;
        const response=await fetchImpl(url,{method:"GET",redirect:"error",headers,signal:controller.signal});
        ensure(isObject(response) && Number.isInteger(response.status),"BAD_RESPONSE");
        if(response.status!==200) {
          const remaining=response.headers?.get?.("x-ratelimit-remaining");
          const retryAfter=response.headers?.get?.("retry-after");
          const status=response.status;
          let throttled=status===429 || (status===403 &&
            (remaining==="0" || (typeof retryAfter==="string" && retryAfter.trim()!=="")));
          // Secondary API limits may return 403 without zero remaining quota.
          if(status===403 && !throttled) {
            try {
              const detail=await response.json();
              const message=typeof detail?.message==="string" ? detail.message : "";
              throttled=/secondary rate limit|rate limit exceeded|abuse detection|too many requests/i.test(message);
            } catch(error) {
              // Invalid JSON still means denied; transport abort/network errors
              // must reach the outer timeout/retry classifier.
              if(!(error instanceof SyntaxError)) throw error;
            }
          }
          throw new ReadFailure(status===404 ? "NOT_FOUND" :
            throttled ? "RATE_LIMIT" :
            status===401 || status===403 ? "ACCESS_DENIED" :
            status>=500 ? "UPSTREAM_ERROR" : "BAD_RESPONSE");
        }
        let json;
        try { json=await response.json(); }
        catch(error) {
          if(error instanceof SyntaxError) throw new ReadFailure("BAD_RESPONSE");
          throw error;
        }
        ensure(isObject(json),"BAD_RESPONSE");
        return json;
      } catch(error) {
        const issue=error instanceof ReadFailure ? error :
          new ReadFailure(error?.name==="AbortError" ? "TIMEOUT" : "NETWORK_ERROR");
        if(["UPSTREAM_ERROR","TIMEOUT","NETWORK_ERROR"].includes(issue.code) && attempt<maxRetries) {
          await sleep(25*(attempt+1));
          continue;
        }
        throw issue;
      } finally { clearTimeout(timer); }
    }
    throw new ReadFailure("UPSTREAM_ERROR");
  }
  async function read(projectId,{expectedSha}={}) {
    const source=Object.hasOwn(APPROVED_SOT_SOURCES,projectId) ? APPROVED_SOT_SOURCES[projectId] : null;
    if(!source) return {ok:false,status:"NOT_ALLOWED",projectId:String(projectId),content:null};
    if(expectedSha!==undefined && (typeof expectedSha!=="string" || !SHA.test(expectedSha)))
      return {ok:false,status:"BAD_REVISION",projectId,content:null};
    const saved=cached.get(projectId);
    const moment=now();
    // Explicit immutable revision checks must always revalidate live main.
    if(saved && expectedSha===undefined && moment>=saved.fetchedAt &&
       moment-saved.fetchedAt<cacheTtlMs) {
      return copySnapshot(saved,true);
    }
    const root="https://api.github.com/repos/"+source.repo;
    const mainUrl=root+"/commits/main";
    let observedMainSha=null;
    try {
      const first=await getJson(mainUrl);
      ensure(typeof first.sha==="string" && SHA.test(first.sha),"BAD_RESPONSE");
      observedMainSha=first.sha;
      if(expectedSha!==undefined && expectedSha!==observedMainSha) throw new ReadFailure("MAIN_DIVERGED");
      const path=source.path.split("/").map(encodeURIComponent).join("/");
      const payload=await getJson(root+"/contents/"+path+"?ref="+observedMainSha);
      const content=decodeFile(payload,maxBytes);
      const second=await getJson(mainUrl);
      ensure(typeof second.sha==="string" && SHA.test(second.sha),"BAD_RESPONSE");
      if(second.sha!==observedMainSha) throw new ReadFailure("MAIN_DIVERGED");
      const fetchedAt=now();
      const snapshot={
        ok:true,status:"CURRENT",projectId,source:{...source},
        revision:{repo:source.repo,path:source.path,sha:observedMainSha,
          url:"https://github.com/"+source.repo+"/blob/"+observedMainSha+"/"+source.path},
        content,fetchedAt,fromCache:false
      };
      cached.set(projectId,Object.freeze({
        ...snapshot,
        source:Object.freeze({...snapshot.source}),
        revision:Object.freeze({...snapshot.revision})
      }));
      return copySnapshot(snapshot,false);
    } catch(error) {
      const code=error instanceof ReadFailure ? error.code : "NETWORK_ERROR";
      // No stale content is ever presented as fresh authoritative data.
      return {ok:false,status:code==="MAIN_DIVERGED" ? code : saved ? "STALE" : code,
        reason:saved ? code : undefined,projectId,source:{...source},
        observedMainSha,expectedSha:expectedSha??null,
        cachedAt:saved?.fetchedAt??null,content:null};
    }
  }
  return Object.freeze({read});
}
