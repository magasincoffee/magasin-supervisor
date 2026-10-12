// MPC-003: bounded read-only GitHub/SOT transport. No dispatch, persistence, or execution authority.
const SHA = /^[0-9a-f]{40}$/;
const SOURCES = Object.freeze({
  supervisor: Object.freeze({ repository: 'magasincoffee/magasin-supervisor', path: 'SOURCE_OF_TRUTH.md' }),
  workforce: Object.freeze({ repository: 'magasincoffee/magasincoffee.github.io', path: '01_DOCS/MAGASIN/05_SYSTEM/WORKFORCE_CROSS_STORE_SCHEDULING_TEMP_SOURCE_OF_TRUTH.md' }),
  print_ops: Object.freeze({ repository: 'magasincoffee/OPS-WebApp', path: 'SOURCE_OF_TRUTH.md' }),
});
export const PROJECT_SOT_SOURCES = SOURCES;
export const SOT_READ_STATUSES = Object.freeze([
  'OK', 'INVALID_SOURCE', 'MAIN_DIVERGED', 'NOT_FOUND', 'RATE_LIMITED',
  'ACCESS_DENIED', 'STALE', 'UNAVAILABLE', 'INVALID_RESPONSE',
]);
const API = 'https://api.github.com/repos/';
const MAX_BYTES = 524288;
const isSha = sha => typeof sha === 'string' && SHA.test(sha);
const clamp = (value, fallback, low, high) =>
  Number.isInteger(value) && value >= low && value <= high ? value : fallback;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const pathEncode = path => path.split('/').map(encodeURIComponent).join('/');

// The fetch implementation may be a server-side authenticated GitHub transport.
// Credentials are neither passed to this module nor returned in diagnostics.
export function createProjectSotReader({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = wait,
  ttlMs = 30000,
  maxEntries = 24,
  maxAttempts = 2,
  timeoutMs = 5000,
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof sleep !== 'function')
    throw new TypeError('SOT reader requires fetch, clock and bounded sleep functions');
  const ttl = clamp(ttlMs, 30000, 1000, 60000);
  const limit = clamp(maxEntries, 24, 1, 32);
  const attempts = clamp(maxAttempts, 2, 1, 3);
  const timeout = clamp(timeoutMs, 5000, 100, 10000);
  const cache = new Map();
  const headers = Object.freeze({
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  });

  async function request(url) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET', headers,
          redirect: 'error',
          signal: AbortSignal.timeout(timeout),
        });
      } catch {
        if (attempt === attempts) return { status: 'UNAVAILABLE' };
        await sleep(Math.min(200 * attempt, 600));
        continue;
      }
      if (!response || typeof response.status !== 'number')
        return { status: 'INVALID_RESPONSE' };
      const code = response.status;
      if (code === 404) return { status: 'NOT_FOUND' };
      if (code === 429 || (code === 403 && response.headers?.get?.('x-ratelimit-remaining') === '0'))
        return { status: 'RATE_LIMITED' };
      if (code === 401 || code === 403) return { status: 'ACCESS_DENIED' };
      if ([500, 502, 503, 504].includes(code)) {
        if (attempt === attempts) return { status: 'UNAVAILABLE' };
        await sleep(Math.min(200 * attempt, 600));
        continue;
      }
      if (code !== 200) return { status: 'UNAVAILABLE' };
      try {
        return { status: 'OK', data: await response.json() };
      } catch {
        return { status: 'INVALID_RESPONSE' };
      }
    }
    return { status: 'UNAVAILABLE' };
  }

  function failure(status, sourceId, source, expectedSha, observedSha = null) {
    return {
      status, sourceId,
      repository: source?.repository ?? null,
      path: source?.path ?? null,
      expectedSha: expectedSha ?? null,
      observedSha,
      content: null,
      verified: false,
    };
  }

  async function read(sourceId, { expectedSha } = {}) {
    // Source is selected ONLY by a fixed identifier; never form an endpoint from
    // user-provided repository, URL, branch, or SOT path.
    if (typeof sourceId !== 'string' || !Object.hasOwn(SOURCES, sourceId) || !isSha(expectedSha))
      return failure('INVALID_SOURCE', typeof sourceId === 'string' ? sourceId : null,
        typeof sourceId === 'string' && Object.hasOwn(SOURCES, sourceId) ? SOURCES[sourceId] : null,
        expectedSha);
    const source = SOURCES[sourceId];
    const timestamp = now();
    const key = `${sourceId}:${expectedSha}`;
    const existing = cache.get(key);
    const stale = existing && timestamp - existing.observedAt >= ttl;
    const head = await request(`${API}${source.repository}/commits/main`);
    if (head.status !== 'OK')
      return failure(stale && ['UNAVAILABLE', 'INVALID_RESPONSE'].includes(head.status)
        ? 'STALE' : head.status, sourceId, source, expectedSha);
    const observedSha = head.data?.sha;
    if (!isSha(observedSha)) return failure('INVALID_RESPONSE', sourceId, source, expectedSha);
    if (observedSha !== expectedSha)
      return failure('MAIN_DIVERGED', sourceId, source, expectedSha, observedSha);

    if (existing && !stale)
      return {
        status: 'OK', sourceId, repository: source.repository, path: source.path,
        expectedSha, observedSha, content: existing.content, verified: false,
        cached: true, observedAt: timestamp,
        url: `https://github.com/${source.repository}/blob/${expectedSha}/${source.path}`,
      };
    const raw = await request(`${API}${source.repository}/contents/${pathEncode(source.path)}?ref=${expectedSha}`);
    if (raw.status !== 'OK')
      return failure(stale && ['UNAVAILABLE', 'INVALID_RESPONSE'].includes(raw.status)
        ? 'STALE' : raw.status, sourceId, source, expectedSha, observedSha);
    const data = raw.data;
    if (data?.type !== 'file' || data?.encoding !== 'base64' ||
        !Number.isInteger(data?.size) || data.size < 0 || data.size > MAX_BYTES ||
        typeof data.content !== 'string' || data.content.length > Math.ceil(MAX_BYTES * 4 / 3) + 32 ||
        !/^[A-Za-z0-9+/=\r\n]+$/.test(data.content))
      return failure('INVALID_RESPONSE', sourceId, source, expectedSha, observedSha);
    let content;
    try {
      const bytes = Buffer.from(data.content.replace(/[\r\n]/g, ''), 'base64');
      if (bytes.length !== data.size || bytes.length > MAX_BYTES) throw new Error('content size mismatch');
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return failure('INVALID_RESPONSE', sourceId, source, expectedSha, observedSha);
    }
    // Recheck HEAD after pinned content fetch: never report OK if main changed meanwhile.
    const finalHead = await request(`${API}${source.repository}/commits/main`);
    if (finalHead.status !== 'OK')
      return failure(finalHead.status, sourceId, source, expectedSha, observedSha);
    if (!isSha(finalHead.data?.sha))
      return failure('INVALID_RESPONSE', sourceId, source, expectedSha);
    if (finalHead.data.sha !== expectedSha)
      return failure('MAIN_DIVERGED', sourceId, source, expectedSha, finalHead.data.sha);
    cache.delete(key);
    cache.set(key, { content, observedAt: timestamp });
    if (cache.size > limit) cache.delete(cache.keys().next().value);
    return {
      status: 'OK', sourceId, repository: source.repository, path: source.path,
      expectedSha, observedSha, content, verified: false,
      cached: false, observedAt: timestamp,
      url: `https://github.com/${source.repository}/blob/${expectedSha}/${source.path}`,
    };
  }
  return Object.freeze({ read });
}