import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectSotReader, PROJECT_SOT_SOURCES, SOT_READ_STATUSES } from '../src/project_sot_reader.mjs';
const sha = 'a'.repeat(40), next = 'b'.repeat(40);
const apiJson = (data, status = 200, headers = {}) => ({
  status, headers: { get: k => headers[k] ?? null }, async json() { return data; },
});
const file = text => ({ type: 'file', encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') });
const queue = (items) => {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, options });
    const answer = items.shift();
    if (answer instanceof Error) throw answer;
    if (!answer) throw Error('Unexpected extra GitHub request');
    return answer;
  };
  return { transport, calls };
};
const reader = (items, other = {}) => {
  const mock = queue(items);
  return { client: createProjectSotReader({ fetchImpl: mock.transport, sleep: async () => {}, ...other }), ...mock };
};
test('read-only allowlist prevents untrusted repositories, paths, branch and missing SHA', async () => {
  const mock = reader([]);
  for (const id of ['../OPS-WebApp', 'https://evil.example/', '__proto__', 'other', null])
    assert.equal((await mock.client.read(id, { expectedSha: sha })).status, 'INVALID_SOURCE');
  assert.equal((await mock.client.read('supervisor', { expectedSha: 'main' })).status, 'INVALID_SOURCE');
  assert.equal((await mock.client.read('supervisor', { expectedSha: [sha] })).status, 'INVALID_SOURCE');
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(Object.keys(PROJECT_SOT_SOURCES), ['supervisor','workforce','print_ops']);
  assert.ok(SOT_READ_STATUSES.includes('MAIN_DIVERGED'));
});
test('pinned SOT content remains unverified; immutable URL, GET-only fixed host and double head-check', async () => {
  const mock = reader([apiJson({ sha }), apiJson(file('SOT authority')), apiJson({ sha })]);
  const res = await mock.client.read('supervisor', { expectedSha: sha });
  assert.equal(res.status, 'OK');
  assert.equal(res.content, 'SOT authority');
  assert.equal(res.verified, false);
  assert.equal(res.url, `https://github.com/magasincoffee/magasin-supervisor/blob/${sha}/SOURCE_OF_TRUTH.md`);
  assert.equal(mock.calls.length, 3);
  assert.ok(mock.calls.every(c => c.options.method === 'GET' && c.url.startsWith('https://api.github.com/repos/magasincoffee/magasin-supervisor/')));
  assert.ok(mock.calls[1].url.endsWith(`contents/SOURCE_OF_TRUTH.md?ref=${sha}`));
});
test('cache HIT only on validated same HEAD, cache expiry forces reread', async () => {
  let now = 10000;
  const mock = reader([apiJson({ sha }),apiJson(file('v1')),apiJson({ sha }),apiJson({ sha }),apiJson({ sha }),apiJson(file('v2')),apiJson({ sha })], { now:()=>now, ttlMs:1000 });
  const a = await mock.client.read('supervisor', { expectedSha: sha });
  assert.equal(a.cached, false);
  now += 900;
  const b = await mock.client.read('supervisor', { expectedSha: sha });
  assert.equal(b.cached, true);
  assert.equal(b.content, 'v1');
  now += 101;
  const c = await mock.client.read('supervisor', { expectedSha: sha });
  assert.equal(c.cached, false);
  assert.equal(c.content, 'v2');
  assert.equal(mock.calls.length, 7);
});
test('fail visibly when main SHA diverges including during pinned content fetch', async () => {
  const a = reader([apiJson({ sha: next })]);
  const result = await a.client.read('supervisor',{ expectedSha:sha });
  assert.equal(result.status, 'MAIN_DIVERGED');
  assert.equal(result.content, null);
  assert.equal(result.observedSha, next);
  const b = reader([apiJson({ sha }),apiJson(file('old')),apiJson({ sha:next })]);
  assert.equal((await b.client.read('supervisor',{expectedSha:sha})).status,'MAIN_DIVERGED');
});
test('404, API rate limit, and access-denied fail closed without retries',async()=>{
  for(const [response,status] of [
    [apiJson({},404),'NOT_FOUND'],
    [apiJson({},429),'RATE_LIMITED'],
    [apiJson({},403,{'x-ratelimit-remaining':'0'}),'RATE_LIMITED'],
    [apiJson({},403),'ACCESS_DENIED'],
    [apiJson({},401),'ACCESS_DENIED'],
  ]){
    const mock=reader([response]);
    const out=await mock.client.read('print_ops',{expectedSha:sha});
    assert.equal(out.status,status);
    assert.equal(out.content,null);
    assert.equal(mock.calls.length,1);
  }
});
test('bounded retry on 503 or network exception and stop after cap',async()=>{
  let waits=0;
  const mock=reader([apiJson({},503),new Error('socket'),apiJson({sha})],{maxAttempts:2,sleep:async()=>{waits++;}});
  const r=await mock.client.read('supervisor',{expectedSha:sha});
  assert.equal(r.status,'UNAVAILABLE');
  assert.equal(mock.calls.length,2);
  assert.equal(waits,1);
  const b=reader([new Error('temporary'),apiJson({sha}),apiJson(file('safe')),apiJson({sha})]);
  assert.equal((await b.client.read('supervisor',{expectedSha:sha})).status,'OK');
  assert.equal(b.calls.length,4);
});
test('stale cache never yields stale content when main check or re-fetch fails',async()=>{
  let now=0;
  const mock=reader([apiJson({sha}),apiJson(file('old')),apiJson({sha}),new Error('down'),new Error('still down')],{now:()=>now,ttlMs:1000,maxAttempts:2});
  assert.equal((await mock.client.read('supervisor',{expectedSha:sha})).status,'OK');
  now=1001;
  const result=await mock.client.read('supervisor',{expectedSha:sha});
  assert.equal(result.status,'STALE');
  assert.equal(result.content,null);
});
test('invalid JSON, invalid file and oversized response fail closed',async()=>{
  const a=reader([apiJson({notsha:'bad'})]);
  assert.equal((await a.client.read('supervisor',{expectedSha:sha})).status,'INVALID_RESPONSE');
  const b=reader([apiJson({sha}),apiJson({type:'symlink',encoding:'base64',size:2,content:'YQ=='})]);
  assert.equal((await b.client.read('supervisor',{expectedSha:sha})).status,'INVALID_RESPONSE');
  const c=reader([apiJson({sha}),apiJson({type:'file',encoding:'base64',size:524289,content:'YQ=='})]);
  assert.equal((await c.client.read('supervisor',{expectedSha:sha})).status,'INVALID_RESPONSE');
  const d=reader([apiJson({sha}),apiJson({type:'file',encoding:'base64',size:1,content:'YQ==' }),apiJson({sha})]);
  assert.equal((await d.client.read('supervisor',{expectedSha:sha})).status,'OK');
});
test('branch cannot be selected from caller; workforce path remains canonical',async()=>{
  const mock=reader([apiJson({sha}),apiJson(file('workforce')),apiJson({sha})]);
  const response=await mock.client.read('workforce',{expectedSha:sha, branch:'malicious'});
  assert.equal(response.status,'OK');
  assert.ok(mock.calls[1].url.includes('WORKFORCE_CROSS_STORE_SCHEDULING_TEMP_SOURCE_OF_TRUTH.md'));
  assert.ok(mock.calls.every(c=>!c.url.includes('malicious')));
});