// SC-013 phase 1: fail-closed, read-only SOT authority verification.
// An Issue/SQLite row is input, never task authority. This module never dispatches.
const CANONICAL = Object.freeze({
  supervisor: Object.freeze({
    repo: 'magasincoffee/magasin-supervisor',
    path: 'SOURCE_OF_TRUTH.md',
    url: 'https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md',
    taskIds: ['SC-013'],
  }),
});
const ACTIONS = new Set(['execute_task']);
const MAX_SOT_BYTES = 2_000_000;
export const NON_EXECUTING = false;

export function validateEnvelope(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'INVALID_REQUEST' };
  if (input.schema !== 'MAGASIN_DISPATCH_V1') return { ok: false, reason: 'INVALID_SCHEMA' };
  // Reject attached commands/prompts/unknown issue fields, even if other keys match.
  const allowedFields = new Set(['schema', 'action', 'target', 'task_id', 'sot_url', 'source_id', 'status']);
  if (Object.keys(input).some((key) => !allowedFields.has(key))) {
    return { ok: false, reason: 'UNEXPECTED_REQUEST_FIELD' };
  }
  if (input.source_id !== undefined &&
      (typeof input.source_id !== 'string' ||
       !/^github:magasincoffee\/magasin-supervisor:issue:[0-9]{1,14}$/.test(input.source_id))) {
    return { ok: false, reason: 'INVALID_GATEWAY_SOURCE' };
  }
  if (input.status !== undefined && (typeof input.status !== 'string' ||
      !/^[A-Z_]{1,64}$/.test(input.status))) {
    return { ok: false, reason: 'INVALID_GATEWAY_STATE' };
  }
  if (!ACTIONS.has(input.action)) return { ok: false, reason: 'ACTION_NOT_SUPPORTED' };
  const policy = CANONICAL[input.target];
  if (!policy) return { ok: false, reason: 'TARGET_NOT_QUALIFIED' };
  if (input.sot_url !== policy.url) return { ok: false, reason: 'SOT_URL_MISMATCH' };
  if (typeof input.task_id !== 'string' || !policy.taskIds.includes(input.task_id)) {
    return { ok: false, reason: 'TASK_NOT_ALLOWLISTED' };
  }
  // The caller must independently verify the GitHub author and Gateway SQLite receipt.
  // The request itself is never accepted as a trusted owner-authentication proof.
  return { ok: true, policy };
}

export function inspectSot(text, taskId) {
  if (typeof text !== 'string' || !text.startsWith('# MAGASIN Supervisor — SOURCE OF TRUTH\n')) {
    return { ok: false, reason: 'SOT_IDENTITY_MISMATCH' };
  }
  if (!text.includes('CANONICAL / SOLE PROJECT AUTHORITY')) {
    return { ok: false, reason: 'SOT_AUTHORITY_MISSING' };
  }
  // Match exactly one canonical task section, not prose/examples/other IDs.
  const headings = [...text.matchAll(/^### (SC-[0-9]{3}) — [^\r\n]+$/gm)];
  const matches = headings.filter((m) => m[1] === taskId);
  if (matches.length !== 1) return { ok: false, reason: 'SOT_TASK_MISSING_OR_AMBIGUOUS' };
  const match = matches[0];
  const next = text.slice(match.index + match[0].length).search(/^#{2,3} /m);
  const rest = text.slice(match.index + match[0].length);
  const section = next >= 0 ? rest.slice(0, next) : rest;
  const states = [...section.matchAll(/^State: \*\*(READY|IN PROGRESS|COMPLETE|BLOCKED|DONE)\*\*\s*$/gm)];
  if (states.length !== 1) return { ok: false, reason: 'TASK_STATE_MISSING_OR_AMBIGUOUS' };
  const state = states[0][1];
  if (state !== 'READY') return { ok: false, reason: 'TASK_NOT_READY', taskState: state };
  // No dependency/Owner permission may be inferred from free prose.
  if (!/^Dependencies: NONE\s*$/m.test(section)) {
    return { ok: false, reason: 'DEPENDENCIES_UNVERIFIED', taskState: state };
  }
  if (!/^Owner gate: CLEARED\s*$/m.test(section)) {
    return { ok: false, reason: 'OWNER_GATE_UNVERIFIED', taskState: state };
  }
  return { ok: true, taskState: state };
}

function response(status, extra = {}) {
  return { schema: 'MAGASIN_SOT_ADAPTER_RESULT_V1', status,
    execution_qualified: NON_EXECUTING, dispatched: false, ...extra };
}

export async function verifySot(request, { readJson, guards } = {}) {
  const checked = validateEnvelope(request);
  if (!checked.ok) return response('REJECTED', { reason: checked.reason });
  const p = checked.policy;
  // Guards are supplied by trusted local lifecycle readers, not Issue fields.
  if (!guards || guards.targetMachine !== 'DESKTOP-H4A16IL') {
    return response('REJECTED', { reason: 'TARGET_MACHINE_NOT_VERIFIED' });
  }
  if (guards.ownerStop !== false || guards.autostartDisabled !== false) {
    return response('WAIT_OWNER_STOP', { reason: 'OWNER_STOP_OR_AUTOSTART_DISABLED' });
  }
  if (guards.coordinatorEnabled !== true || guards.specialistEnabled !== true ||
      guards.workerAlive !== true || guards.ownerAuthorizationVerified !== true) {
    return response('WAIT_OWNER_ENABLE', { reason: 'RUNTIME_GUARDS_NOT_VERIFIED' });
  }
  if (typeof readJson !== 'function') return response('WAIT_SOT_AUTHORITY', { reason: 'SOT_FETCH_UNAVAILABLE' });
  const base = 'https://api.github.com/repos/' + p.repo;
  try {
    // Pin the contents to a real commit and recheck main to close TOCTOU on source selection.
    const head1 = await readJson(base + '/commits/main');
    const commitSha = head1?.sha;
    if (!/^[a-f0-9]{40}$/.test(commitSha ?? '')) throw new Error('INVALID_HEAD_SHA');
    const doc = await readJson(base + '/contents/' + p.path + '?ref=' + commitSha);
    if (doc?.type !== 'file' || doc?.encoding !== 'base64' ||
        !/^[a-f0-9]{40}$/.test(doc?.sha ?? '') || typeof doc.content !== 'string' ||
        doc.content.length > Math.ceil(MAX_SOT_BYTES * 4 / 3) + 10) {
      throw new Error('SOT_CONTENT_INVALID');
    }
    const raw = Buffer.from(doc.content.replace(/\s/g, ''), 'base64');
    if (raw.length > MAX_SOT_BYTES || !raw.length) throw new Error('SOT_SIZE_INVALID');
    // Reject malformed base64 instead of silently accepting Buffer's permissive decoder.
    if (raw.toString('base64') !== doc.content.replace(/\s/g, '')) throw new Error('SOT_BASE64_INVALID');
    const head2 = await readJson(base + '/commits/main');
    if (head2?.sha !== commitSha) return response('WAIT_SOT_AUTHORITY', { reason: 'SOT_REVISION_CHANGED' });
    const result = inspectSot(raw.toString('utf8'), request.task_id);
    const evidence = { repo: p.repo, path: p.path, task_id: request.task_id,
      revision: commitSha, blob_sha: doc.sha };
    if (!result.ok) return response('WAIT_SOT_AUTHORITY',
      { reason: result.reason, task_state: result.taskState ?? null, ...evidence });
    // Phase 1 intentionally has no business execution or downstream worker authority.
    return response('SOT_VERIFIED_READ_ONLY', { task_state: result.taskState, ...evidence });
  } catch (error) {
    return response('WAIT_SOT_AUTHORITY', { reason: 'FETCH_OR_PARSE_FAILED',
      detail_code: /^[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'SOURCE_UNAVAILABLE' });
  }
}

// This helper can be called only by an independently authenticated local reader.
// It is not intended as a public HTTP endpoint or a browser command handler.
export async function githubReadJson(url, { token = process.env.GITHUB_TOKEN, timeoutMs = 8000 } = {}) {
  if (!/^https:\/\/api\.github\.com\/repos\/magasincoffee\/magasin-supervisor\/(commits\/main|contents\/SOURCE_OF_TRUTH\.md\?ref=[a-f0-9]{40})$/.test(url)) {
    throw new Error('URL_NOT_ALLOWLISTED');
  }
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'magasin-sc013-sot-adapter' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error('GITHUB_HTTP_ERROR');
  const declaredSize = Number(r.headers.get('content-length') || 0);
  if (declaredSize > MAX_SOT_BYTES * 2) throw new Error('RESPONSE_TOO_LARGE');
  const body = await r.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_SOT_BYTES * 2) throw new Error('RESPONSE_TOO_LARGE');
  return JSON.parse(body);
}
