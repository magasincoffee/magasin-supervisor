#!/usr/bin/env node
// SC-013 read-only preflight transport for a future trusted local Python Coordinator.
// Input is only a validated Gateway-envelope-shaped JSON record on stdin.
// Never reads Owner-enabled flags, starts specialists, writes local state or dispatches.
import { probeSotReadOnly, githubReadJson } from './sot-adapter.mjs';

const MAX_INPUT_BYTES = 8192;
function report(status, reason) {
  return { schema: 'MAGASIN_SOT_ADAPTER_RESULT_V1', status,
    reason, execution_qualified: false, dispatched: false };
}

let size = 0;
let input = '';
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
    input += chunk.toString('utf8');
  }
  if (!input.trim()) throw new Error('EMPTY_INPUT');
  const payload = JSON.parse(input);
  // A Gateway row is NEVER allowed to supply or assert lifecycle guards.
  const result = await probeSotReadOnly(payload, { readJson: githubReadJson });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  const detail = error?.message === 'INPUT_TOO_LARGE' ? 'INPUT_TOO_LARGE' :
    error?.message === 'EMPTY_INPUT' ? 'EMPTY_INPUT' : 'INVALID_INPUT_OR_IO';
  process.stdout.write(JSON.stringify(report('REJECTED', detail)) + '\n');
}
