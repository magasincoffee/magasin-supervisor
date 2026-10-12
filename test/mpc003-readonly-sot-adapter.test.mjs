import test from "node:test";
import assert from "node:assert/strict";
import {APPROVED_SOT_SOURCES,createReadOnlySotAdapter} from "../src/control-center/project_sot_adapter.mjs";
const A="a".repeat(40), B="b".repeat(40);
const response=(status,body={},headers={})=>({status,headers:{get:key=>headers[key.toLowerCase()]??null},json:async()=>body});
function fixture({shas=[A,A],body="# Canonical SOURCE_OF_TRUTH",onRequest}={}) {
  const calls=[];
  let mainIndex=0;
  const fetchImpl=async(url,opts)=>{
    calls.push({url,opts});
    if(onRequest) return onRequest(url,opts,calls.length);
    if(url.endsWith("/commits/main")) return response(200,{sha:shas[Math.min(mainIndex++,shas.length-1)]});
    if(url.includes("/contents/")) return response(200,{type:"file",encoding:"base64",content:Buffer.from(body).toString("base64")});
    throw Error("UNEXPECTED_ENDPOINT");
  };
  return {fetchImpl,calls};
}
const make=(fetchImpl,more={})=>createReadOnlySotAdapter({fetchImpl,sleep:async()=>{},maxRetries:0,...more});
test("allowlist is explicit, no arbitrary repository or path requests",async()=>{
  assert.deepEqual(Object.keys(APPROVED_SOT_SOURCES).sort(),["print_ops","supervisor","workforce"]);
  const f=fixture();const adapter=make(f.fetchImpl);
  for(const id of ["../../evil","other","__proto__",null]){
    const x=await adapter.read(id);
    assert.equal(x.ok,false);assert.equal(x.status,"NOT_ALLOWED");
  }
  assert.equal(f.calls.length,0);
});
test("happy path pins immutable SHA, rechecks main, and only uses GET without redirects",async()=>{
  const f=fixture();const x=await make(f.fetchImpl).read("supervisor",{expectedSha:A});
  assert.equal(x.ok,true);assert.equal(x.status,"CURRENT");assert.equal(x.revision.sha,A);
  assert.equal(x.content,"# Canonical SOURCE_OF_TRUTH");assert.equal(x.fromCache,false);
  assert.equal(x.revision.url,"https://github.com/magasincoffee/magasin-supervisor/blob/"+A+"/SOURCE_OF_TRUTH.md");
  assert.equal(f.calls.length,3);
  assert.ok(f.calls[1].url.endsWith("/contents/SOURCE_OF_TRUTH.md?ref="+A));
  for(const call of f.calls){assert.equal(call.opts.method,"GET");assert.equal(call.opts.redirect,"error");assert.equal(call.opts.headers.Authorization,undefined);}
  assert.equal("scopeStatus" in x,false);
});
test("workforce and OPS locations stay isolated by server allowlist",async()=>{
  for(const id of ["workforce","print_ops"]){
    const f=fixture();const x=await make(f.fetchImpl).read(id);
    assert.equal(x.ok,true);assert.equal(x.source.repo,APPROVED_SOT_SOURCES[id].repo);
    assert.ok(f.calls.every(c=>c.url.startsWith("https://api.github.com/repos/"+x.source.repo+"/")));
    assert.ok(f.calls[1].url.includes(APPROVED_SOT_SOURCES[id].path));
  }
});
test("bounded fresh cache returns snapshot then refreshes after TTL",async()=>{
  let time=1000;const f=fixture();
  const adapter=make(f.fetchImpl,{now:()=>time,cacheTtlMs:100});
  const x=await adapter.read("supervisor");assert.equal(x.ok,true);
  time+=50;const cached=await adapter.read("supervisor");assert.equal(cached.fromCache,true);assert.equal(f.calls.length,3);
  time+=51;const refreshed=await adapter.read("supervisor");assert.equal(refreshed.fromCache,false);assert.equal(f.calls.length,6);
});
test("404 fails visibly with no retry or fabricated project status",async()=>{
  const f=fixture({onRequest:()=>response(404)});
  const x=await make(f.fetchImpl,{maxRetries:2}).read("supervisor");
  assert.equal(x.ok,false);assert.equal(x.status,"NOT_FOUND");assert.equal(x.content,null);
  assert.equal(f.calls.length,1);
});
test("rate limits 429 and 403 remaining zero are visible and never retried",async()=>{
  for(const status of [429,403]){
    const f=fixture({onRequest:()=>response(status,{},{"x-ratelimit-remaining":"0"})});
    const x=await make(f.fetchImpl,{maxRetries:2}).read("supervisor");
    assert.equal(x.status,"RATE_LIMIT");assert.equal(x.ok,false);assert.equal(f.calls.length,1);
  }
});
test("temporary 503 recovers once within retry cap and request remains GET",async()=>{
  let first=true;const f=fixture({onRequest:(url,opts)=>{
    if(first){first=false;return response(503);}
    if(url.endsWith("/commits/main"))return response(200,{sha:A});
    return response(200,{type:"file",encoding:"base64",content:Buffer.from("safe").toString("base64")});
  }});
  const x=await make(f.fetchImpl,{maxRetries:1}).read("supervisor");
  assert.equal(x.ok,true);assert.equal(f.calls.length,4);
  assert.ok(f.calls.every(c=>c.opts.method==="GET"));
});
test("exhausted upstream failure is terminal after bounded retries",async()=>{
  const f=fixture({onRequest:()=>response(503)});
  const x=await make(f.fetchImpl,{maxRetries:2}).read("supervisor");
  assert.equal(x.status,"UPSTREAM_ERROR");assert.equal(f.calls.length,3);
});
test("expired cached snapshot fails closed on rate limit without leaking cached content",async()=>{
  let time=1000;let fail=false;
  const f=fixture({onRequest:(url)=>{
    if(fail)return response(429);
    if(url.endsWith("/commits/main"))return response(200,{sha:A});
    return response(200,{type:"file",encoding:"base64",content:Buffer.from("OLD_SOURCE").toString("base64")});
  }});
  const adapter=make(f.fetchImpl,{now:()=>time,cacheTtlMs:100});
  assert.equal((await adapter.read("supervisor")).ok,true);
  time=1101;fail=true;
  const x=await adapter.read("supervisor");
  assert.equal(x.ok,false);assert.equal(x.status,"STALE");assert.equal(x.reason,"RATE_LIMIT");
  assert.equal(x.content,null);assert.equal(x.cachedAt,1000);
});
test("main mismatch with expected immutable revision fails before file request",async()=>{
  const f=fixture();const x=await make(f.fetchImpl).read("supervisor",{expectedSha:B});
  assert.equal(x.status,"MAIN_DIVERGED");assert.equal(x.observedMainSha,A);
  assert.equal(f.calls.length,1);
});
test("main movement during pinned file download reports MAIN_DIVERGED",async()=>{
  const f=fixture({shas:[A,B]});const x=await make(f.fetchImpl).read("supervisor");
  assert.equal(x.ok,false);assert.equal(x.status,"MAIN_DIVERGED");
  assert.equal(x.content,null);assert.equal(f.calls.length,3);
});
test("malformed SOT payload never becomes current",async()=>{
  for(const content of ["not-base64", ""]){
    const f=fixture({onRequest:url=>url.endsWith("/commits/main")?response(200,{sha:A}):response(200,{type:"file",encoding:"base64",content})});
    const x=await make(f.fetchImpl).read("supervisor");assert.equal(x.status,"BAD_CONTENT");
    assert.equal(x.ok,false);
  }
});
test("invalid SHA input fails before network and bounded configuration is enforced",async()=>{
  const f=fixture();const adapter=make(f.fetchImpl);
  const bad=await adapter.read("supervisor",{expectedSha:[A]});
  assert.equal(bad.status,"BAD_REVISION");assert.equal(f.calls.length,0);
  assert.throws(()=>make(f.fetchImpl,{maxRetries:100}),/BAD_CONFIGURATION/);
  assert.throws(()=>make(f.fetchImpl,{cacheTtlMs:Infinity}),/BAD_CONFIGURATION/);
});
