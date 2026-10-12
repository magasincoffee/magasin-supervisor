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

test("expected revision revalidates main within TTL and reports divergence, never CURRENT cache",async()=>{
  const f=fixture({shas:[A,A,B]});
  const adapter=make(f.fetchImpl,{cacheTtlMs:300000,now:()=>1000});
  assert.equal((await adapter.read("supervisor")).status,"CURRENT");
  const changed=await adapter.read("supervisor",{expectedSha:A});
  assert.equal(changed.ok,false);
  assert.equal(changed.status,"MAIN_DIVERGED");
  assert.equal(changed.observedMainSha,B);
  assert.equal(changed.content,null);
  assert.equal(f.calls.length,4);
});
test("expected revision always rechecks GitHub even with a fresh, matching cache",async()=>{
  const f=fixture();
  const adapter=make(f.fetchImpl,{cacheTtlMs:300000,now:()=>1000});
  const first=await adapter.read("supervisor");
  assert.equal(first.fromCache,false);
  const same=await adapter.read("supervisor",{expectedSha:A});
  assert.equal(same.ok,true);
  assert.equal(same.fromCache,false);
  assert.equal(f.calls.length,6);
});
test("mutating successful and cached responses cannot poison cached source, revision or timestamps",async()=>{
  const f=fixture();
  const adapter=make(f.fetchImpl,{cacheTtlMs:300000,now:()=>1000});
  const original=await adapter.read("supervisor");
  original.revision.sha=B;
  original.source.repo="attacker/repo";
  original.content="FORGED";
  original.fetchedAt=900000;
  const cached=await adapter.read("supervisor");
  assert.equal(cached.fromCache,true);
  assert.equal(cached.content,"# Canonical SOURCE_OF_TRUTH");
  assert.equal(cached.revision.sha,A);
  assert.equal(cached.source.repo,"magasincoffee/magasin-supervisor");
  assert.equal(cached.fetchedAt,1000);
  cached.content="CORRUPTED";
  cached.revision.sha=B;
  cached.source.path="bad.md";
  const again=await adapter.read("supervisor");
  assert.equal(again.content,"# Canonical SOURCE_OF_TRUTH");
  assert.equal(again.revision.sha,A);
  assert.equal(again.source.path,"SOURCE_OF_TRUTH.md");
  assert.equal(f.calls.length,3);
});
test("malformed 200 JSON is BAD_RESPONSE without retry for commit and SOT content",async()=>{
  for(const malformedContent of [false,true]){
    const f=fixture({onRequest:url=>{
      if(malformedContent && url.endsWith("/commits/main"))return response(200,{sha:A});
      return {status:200,headers:{get:()=>null},json:async()=>{throw new SyntaxError("malformed JSON")}};
    }});
    const result=await make(f.fetchImpl,{maxRetries:2}).read("supervisor");
    assert.equal(result.ok,false);
    assert.equal(result.status,"BAD_RESPONSE");
    assert.equal(result.content,null);
    assert.equal(f.calls.length,malformedContent?2:1);
  }
});

test("invalid UTF-8 bytes fail closed as BAD_CONTENT without retry or fabricated CURRENT",async()=>{
  for(const bytes of [
    Buffer.from([0xc3,0x28]),  // invalid continuation
    Buffer.from([0xe2,0x82]),  // truncated multibyte sequence
    Buffer.from([0xff]),       // illegal UTF-8 byte
    Buffer.from([0xed,0xa0,0x80]) // surrogate codepoint
  ]){
    const f=fixture({body:bytes});
    const result=await make(f.fetchImpl,{maxRetries:2}).read("supervisor");
    assert.equal(result.ok,false);
    assert.equal(result.status,"BAD_CONTENT");
    assert.equal(result.content,null);
    assert.equal(f.calls.length,2);
  }
});
test("invalid UTF-8 cannot enter cache and a later valid pinned file is read afresh",async()=>{
  let invalid=true;
  const f=fixture({onRequest:url=>{
    if(url.endsWith("/commits/main")) return response(200,{sha:A});
    const bytes=invalid?Buffer.from([0xff]):Buffer.from("Đúng dữ liệu SOT","utf8");
    return response(200,{type:"file",encoding:"base64",content:bytes.toString("base64")});
  }});
  const adapter=make(f.fetchImpl,{cacheTtlMs:300000,now:()=>1000});
  assert.equal((await adapter.read("supervisor")).status,"BAD_CONTENT");
  invalid=false;
  const fresh=await adapter.read("supervisor");
  assert.equal(fresh.status,"CURRENT");
  assert.equal(fresh.content,"Đúng dữ liệu SOT");
  assert.equal(f.calls.length,5);
  const cached=await adapter.read("supervisor");
  assert.equal(cached.fromCache,true);
  assert.equal(cached.content,"Đúng dữ liệu SOT");
});

test("secondary GitHub 403 throttles classify RATE_LIMIT even when quota is nonzero",async()=>{
  const variants=[
    response(403,{message:"forbidden"},{"x-ratelimit-remaining":"100","retry-after":"15"}),
    response(403,{message:"You have exceeded a secondary rate limit."},{"x-ratelimit-remaining":"99"}),
    response(403,{message:"API rate limit exceeded for user"},{"x-ratelimit-remaining":"12"})
  ];
  for(const denied of variants){
    const f=fixture({onRequest:()=>denied});
    const x=await make(f.fetchImpl,{maxRetries:2}).read("supervisor");
    assert.equal(x.status,"RATE_LIMIT");
    assert.equal(x.ok,false);
    assert.equal(f.calls.length,1);
  }
});
test("plain permission-denied GitHub 403 remains ACCESS_DENIED and has no retry",async()=>{
  const f=fixture({onRequest:()=>response(403,{message:"Resource not accessible by integration"},{"x-ratelimit-remaining":"200"})});
  const x=await make(f.fetchImpl,{maxRetries:2}).read("supervisor");
  assert.equal(x.status,"ACCESS_DENIED");
  assert.equal(x.ok,false);
  assert.equal(f.calls.length,1);
});
