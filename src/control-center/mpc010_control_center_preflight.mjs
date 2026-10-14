// MPC-010 SOURCE/QA ONLY. Pure metadata classification; never call this a field H4 approval.
// Caller-supplied evidence is untrusted, including host, hashes, STOP and rollback assertions.
export const H4_IDENTITY = 'DESKTOP-H4A16IL';
export const H4_OWNER = 'DESKTOP-H4A16IL\\admin';
export const LOCAL_BIND = '127.0.0.1:8781';
export const CONTROL_CENTER_BUNDLE = Object.freeze([
  'src/control-center/server.py',
  'src/control-center/owner_request_drafts.py',
  'src/control-center/project_tree_catalogue.py',
  'src/control-center/supervisor_project_activation.py',
  'src/control-center/web/app.js',
  'src/control-center/web/index.html',
  'src/control-center/web/styles.css',
  'src/control-center/web/project_tree_view.mjs',
  'src/control-center/web/project_detail_view.mjs',
  'src/control-center/web/project_request_view.mjs',
  'src/control-center/web/project_supervisor_telemetry.mjs',
  'docs/project-control/MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md',
]);
// Source-only fixed bytes from the PR's source tree; never trust caller-created
// SHA strings just because they have the right length. Recompute and re-review
// these pins if any candidate source/plan bytes change before a field release.
export const REVIEWED_CANDIDATE_SHA256_20261014 = Object.freeze({
  "src/control-center/server.py":"211822B71A1A390A56B3D6007820C6EF365ED6718CB5608FAFC6E49E09A95AB5",
  "src/control-center/owner_request_drafts.py":"FB980274D7A4BFE7B6544E57EFC42F9D9FB05BCDD7D9373E1ABE2B6FF1E2C156",
  "src/control-center/project_tree_catalogue.py":"47514EAF18EA7D8ED82E3855B299B5A5C2A019D875A26F52A5D3C27E1850626F",
  "src/control-center/supervisor_project_activation.py":"AABD0035567207D465A383FC7CB618A739EE9AB1BA37E9CDF20C659505BDE74F",
  "src/control-center/web/app.js":"3C191CE9CEDA5BEEF2902216849CEF89858359F4C1021F741EF1F4D7BCBD87F7",
  "src/control-center/web/index.html":"53A166F27EE4B9B27B8923114A614421FBC5B8AB3EB5FDCBC661A2829B09D681",
  "src/control-center/web/styles.css":"E3637E0E88CD61DBB23221DD43FB7104DE09C440A52C06B5FCC466F91B3DD2AA",
  "src/control-center/web/project_tree_view.mjs":"4B286BB70303F645FC58F724C94790CEC75A77AD919E3C05B762325B07319D83",
  "src/control-center/web/project_detail_view.mjs":"BF4DA5B6F190EDA78A0600CC90277B1BC8E51D1096641719E190C30880987C5E",
  "src/control-center/web/project_request_view.mjs":"634A88B3C90C7537185A334C9D6F9AC141E4D5FD05EBCCA1A85DA056E8E92272",
  "src/control-center/web/project_supervisor_telemetry.mjs":"2F7CD0F3DEEB436D70FFCFD4804054416A13880A0C603C73F11A97F83DDB77D7",
  "docs/project-control/MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md":"2786B562E4B16859427A8FA24DA58A2D526746C08A8F5BCD3E9D1719F4EA000F",
});
export const H4_OBSERVED_20261014 = Object.freeze({
  'server.py':'3ED5333493E3F4A3884BF78083C20FDD6C53B01AF77428E075E3A987F50165FB',
  'web\\app.js':'1CF3119D30276B6A2237E0E060FAD9450E537EF85A09D3DB8FA32EF936B35BAA',
  'web\\index.html':'C982C99AB98C2AA03E23D0520CC15016652E027038AD1EC31BE31152C0E0484A',
  'web\\styles.css':'0968EFA7E7747ACCCFB47E214754CE0F74444E794EE9532DE29F3FEA19514C68',
  'supervisor_project_links.py':'AE352EAB4B6E5FE892BFE9FD1301120313B45C03ED605B9DBEEC403CC4367ACF',
});
// Existing H4 imports NOT recreated from GitHub. Their byte identities must be
// separately frozen and compatibility-probed during a future field release.
export const PRESERVED_RUNTIME_DEPENDENCIES_20261014 = Object.freeze({
  'D:\\MAGASIN_ROBOTS\\control-center\\observability.py':'7B4E2BBC830E8136D5256D223EF59E2B3CCAA9F0D77596F0F3CCDD6DE68AE469',
  'D:\\MAGASIN_ROBOTS\\control-center\\cutover_preflight.py':'1A2F9D5D91E983F1CF88456BEB14F40934BE19B81250F69071C6CFA1DEF1AF98',
  'D:\\MAGASIN_ROBOTS\\control-center\\specialist_readiness.py':'CBEA44CF78C84C1F06F0F2F972A4E1474D9A789C947B4A03BC74E7FA7FD20AC5',
  'D:\\MAGASIN_ROBOTS\\control-center\\supervisor_project_links.py':'AE352EAB4B6E5FE892BFE9FD1301120313B45C03ED605B9DBEEC403CC4367ACF',
  'D:\\MAGASIN_ROBOTS\\robots\\coordinator\\owner_lifecycle.py':'545E83DC723C545C521DD56EDD7F53559F6A3CCBB1FC25F5C0386A161534B952',
  'D:\\MAGASIN_ROBOTS\\robots\\supervisor\\control_adapter.py':'90F92C32C266C6A3571347169C802C8300FFBBD6F0EC0BDD70143E2F2C68B1E5',
});
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isSha = v => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v);
const isHash = v => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v);
const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj,k);

export function evaluateMpc010ReleaseMetadata(input) {
  const holds=[];
  if (!isObject(input)) {
    return Object.freeze({state:'HOLD',holds:['EVIDENCE_MISSING'],fieldApplyAuthorized:false,
      workerStartAuthorized:false,stageAuthorized:false,productionAccepted:false,
      ownerApprovalEstablished:false,nextGate:'SEPARATE_SOT_APPROVED_H4_RELEASE_PR_AND_OWNER_BOUND_APPLY'});
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
      CONTROL_CENTER_BUNDLE.some(path => !own(input.candidateHashes,path) ||
        !isHash(input.candidateHashes[path]) ||
        String(input.candidateHashes[path]).toUpperCase() !== REVIEWED_CANDIDATE_SHA256_20261014[path]))
    holds.push('INCOMPLETE_OR_UNPINNED_BUNDLE');
  // Source-only frozen inventory: no caller supplied hash or compatibility flag
  // establishes trust. Any missing or changed startup/route-time import blocks
  // even the synthetic metadata-consistent classification.
  if (!isObject(input.preservedDependencyHashes) ||
      !isObject(input.preservedDependencyCompat) ||
      Object.keys(input.preservedDependencyHashes).length !==
        Object.keys(PRESERVED_RUNTIME_DEPENDENCIES_20261014).length ||
      Object.keys(input.preservedDependencyCompat).length !==
        Object.keys(PRESERVED_RUNTIME_DEPENDENCIES_20261014).length ||
      Object.entries(PRESERVED_RUNTIME_DEPENDENCIES_20261014).some(([path,sha]) =>
        !own(input.preservedDependencyHashes,path) ||
        String(input.preservedDependencyHashes[path]).toUpperCase() !== sha ||
        input.preservedDependencyCompat[path] !== true))
    holds.push('PRESERVED_RUNTIME_IMPORT_NOT_PINNED_OR_UNVERIFIED');
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
