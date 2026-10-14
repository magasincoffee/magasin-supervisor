// MPC-010 SOURCE/QA ONLY. Pure metadata classification; never call this a field H4 approval.
// Caller-supplied evidence is untrusted, including host, hashes, STOP and rollback assertions.
export const H4_IDENTITY = 'DESKTOP-H4A16IL';
export const H4_OWNER = 'DESKTOP-H4A16IL\\admin';
export const LOCAL_BIND = '127.0.0.1:8781';
export const CONTROL_CENTER_BUNDLE = Object.freeze([
  'src/control-center/server.py',
  'src/control-center/owner_request_drafts.py',
  'src/control-center/project_tree_catalogue.py',
  'src/control-center/web/app.js',
  'src/control-center/web/index.html',
  'src/control-center/web/styles.css',
  'src/control-center/web/project_tree_view.mjs',
  'src/control-center/web/project_detail_view.mjs',
  'src/control-center/web/project_request_view.mjs',
  'src/control-center/web/project_supervisor_telemetry.mjs',
]);
export const H4_OBSERVED_20261014 = Object.freeze({
  'server.py':'3ED5333493E3F4A3884BF78083C20FDD6C53B01AF77428E075E3A987F50165FB',
  'web\\app.js':'1CF3119D30276B6A2237E0E060FAD9450E537EF85A09D3DB8FA32EF936B35BAA',
  'web\\index.html':'C982C99AB98C2AA03E23D0520CC15016652E027038AD1EC31BE31152C0E0484A',
  'web\\styles.css':'0968EFA7E7747ACCCFB47E214754CE0F74444E794EE9532DE29F3FEA19514C68',
  'supervisor_project_links.py':'AE352EAB4B6E5FE892BFE9FD1301120313B45C03ED605B9DBEEC403CC4367ACF',
});
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isSha = v => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v);
const isHash = v => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v);
const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj,k);

export function evaluateMpc010ReleaseMetadata(input) {
  const holds=[];
  if (!isObject(input)) {
    return Object.freeze({state:'HOLD',holds:['EVIDENCE_MISSING'],fieldApplyAuthorized:false,
      workerStartAuthorized:false,stageAuthorized:false,productionAccepted:false});
  }
  if (input.hostname !== H4_IDENTITY || input.ownerIdentity !== H4_OWNER) holds.push('WRONG_HOST_OR_OWNER');
  if (!isSha(input.expectedMainSha) || input.liveMainSha !== input.expectedMainSha ||
      input.candidateMainSha !== input.expectedMainSha) holds.push('UNPINNED_OR_DIVERGED_MAIN');
  if (input.ownerStopPresent !== true || input.autostartDisabledPresent !== true) holds.push('STOP_LATCH_NOT_PROVEN');
  if (input.wrapperProcessCount !== 0 || input.businessWorkerProcessCount !== 0 ||
      input.ambiguousOutboundAbsent !== true) holds.push('ACTIVE_OR_AMBIGUOUS_WORK');
  if (input.reparsePathsAbsent !== true || input.symlinksAbsent !== true) holds.push('FILE_IDENTITY_UNPROVEN');
  if (!Number.isFinite(input.freeDGiB) || input.freeDGiB < 2) holds.push('ROLLBACK_SPACE_NOT_PROVEN');
  if (!isObject(input.installedHashes)) holds.push('INSTALLED_HASHES_MISSING');
  else for(const [path,sha] of Object.entries(H4_OBSERVED_20261014)) {
    if (!own(input.installedHashes,path) || String(input.installedHashes[path]).toUpperCase() !== sha)
      holds.push('INSTALL_DRIFT:'+path);
  }
  if (!isObject(input.candidateHashes) ||
      Object.keys(input.candidateHashes).length !== CONTROL_CENTER_BUNDLE.length ||
      CONTROL_CENTER_BUNDLE.some(path => !own(input.candidateHashes,path) || !isHash(input.candidateHashes[path])))
    holds.push('INCOMPLETE_OR_UNPINNED_BUNDLE');
  const listeners=input.localPortListeners;
  if (!Array.isArray(listeners) || listeners.length > 1 ||
      listeners.some(v=>!isObject(v) || v.bind !== LOCAL_BIND ||
        v.exactServerPath !== 'D:\\MAGASIN_ROBOTS\\control-center\\server.py' ||
        !Number.isInteger(v.pid) || v.pid<=0)) holds.push('UNKNOWN_OR_MULTIPLE_LISTENER');
  if (input.ownerCredentialConfigured !== false && input.ownerCredentialConfigured !== true)
    holds.push('OWNER_AUTH_STATE_UNKNOWN');
  if (input.rollbackPlan !== 'ISOLATED_D_HASH_VERIFIED_NOT_EXECUTED')
    holds.push('BACKUP_ROLLBACK_NOT_VERIFIED');
  if (input.telemetryReadOnly !== true || input.noSotOrIssueWrites !== true)
    holds.push('MUTATION_SCOPE_NOT_LOCKED');
  return Object.freeze({
    state:holds.length ? 'HOLD' : 'SYNTHETIC_METADATA_CONSISTENT_ONLY',
    holds:Object.freeze(holds),
    fieldApplyAuthorized:false,stageAuthorized:false,workerStartAuthorized:false,
    productionAccepted:false,ownerApprovalEstablished:false,
    nextGate:'SEPARATE_SOT_APPROVED_H4_RELEASE_PR_AND_OWNER_BOUND_APPLY',
  });
}
