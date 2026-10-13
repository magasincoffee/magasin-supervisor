import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import {renderOwnerRequestPanel,selectedRequestTarget,isCurrentOwnerSubmission} from "../src/control-center/web/project_request_view.mjs";
import {renderProjectTree,isSafeProjectCatalogue} from "../src/control-center/web/project_tree_view.mjs";

const selected="supervisor/project-control/MPC-006";
const catalogue={
 status:"LOCAL_UNVERIFIED",readOnly:true,projects:[{
 id:"supervisor",title:"Robot Supervisor",scopeStatus:"UNKNOWN",
 features:[{id:"project-control",title:"MAGASIN PROJECT CONTROL",scopeStatus:"UNKNOWN",
 tasks:[{id:"MPC-006",title:"Gửi đề xuất chỉnh sửa",scopeStatus:"UNKNOWN"}]}]}]
};
const render=(session,draft={})=>renderOwnerRequestPanel({catalogue,selected,session,draft});

test("Only exact listed selected task gets request form",()=>{
 assert.equal(selectedRequestTarget(catalogue,selected)?.key,selected);
 for(const bad of ["", "supervisor", "supervisor/project-control",
  "supervisor/project-control/MPC-007", "print-ops/project-control/MPC-006",
  "supervisor/project-control/../../evil", "<script>"]){
  assert.equal(selectedRequestTarget(catalogue,bad),null);
  assert.doesNotMatch(renderOwnerRequestPanel({catalogue,selected:bad,session:{authenticated:true,login_enabled:true}}),/id="mpc-owner-request-form"/);
 }
});

test("Fails closed and never shows writable form before verified Owner session",()=>{
 const unconfigured=render(null);
 assert.match(unconfigured,/Chưa cấu hình phiên đăng nhập Owner/);
 assert.doesNotMatch(unconfigured,/id="mpc-owner-request-form"/);
 const unauthenticated=render({login_enabled:true,authenticated:false});
 assert.match(unauthenticated,/id="mpc-owner-login-form"/);
 assert.match(unauthenticated,/type="password"/);
 assert.doesNotMatch(unauthenticated,/id="mpc-owner-request-form"/);
 const locked=render({login_enabled:false,authenticated:true});
 assert.doesNotMatch(locked,/id="mpc-owner-request-form"/);
});

test("Owner form supports Vietnamese task-specific text, priority, bounded screenshot URLs",()=>{
 const html=render({login_enabled:true,authenticated:true},{
  description:"Đổi nút <img src=x onerror=alert(1)> theo yêu cầu",
  screenshots:"https://github.com/user-attachments/assets/70d27727-118a-4246-ac55-237479747f91",
  priority:"HIGH"
 });
 assert.match(html,/id="mpc-owner-request-form"/);
 assert.match(html,/data-target="supervisor\/project-control\/MPC-006"/);
 assert.match(html,/id="mpc-owner-description"/);
 assert.match(html,/selected>Cao/);
 assert.match(html,/id="mpc-owner-screenshots"/);
 assert.match(html,/tối đa 3/);
 assert.match(html,/&lt;img/);
 assert.doesNotMatch(html,/<img src=x/);
 assert.doesNotMatch(html,/data-owner-start|data-owner-stop|action="\/api\/owner/);
});

test("Receipt reports pending Owner review only, not approved or running",()=>{
 const html=renderOwnerRequestPanel({catalogue,selected,session:{login_enabled:true,authenticated:true},
  receipt:{request_id:"abc123",status:"PENDING_OWNER_REVIEW",dispatch_authorized:false}});
 assert.match(html,/Chờ Owner xem xét/);
 assert.doesNotMatch(html,/Đã phê duyệt|Đang thực thi|VERIFIED_DONE/);
 const tree=renderProjectTree({catalogue,selected,expanded:["supervisor","supervisor/project-control"],
  ownerRequest:{session:{login_enabled:true,authenticated:true}}});
 assert.match(tree,/id="mpc-owner-request-form"/);
 assert.match(tree,/Chưa xác minh/);
});

test("Browser uses scoped cookie, two independent CSRF headers and stable retry key",async()=>{
 const app=await fs.readFile(new URL("../src/control-center/web/app.js",import.meta.url),"utf8");
 const server=await fs.readFile(new URL("../src/control-center/server.py",import.meta.url),"utf8");
 assert.match(app,/credentials:"same-origin"/);
 assert.match(app,/X-MPC-CSRF/);
 assert.match(app,/X-MAGASIN-CSRF/);
 assert.match(app,/crypto\.randomUUID\(\)/);
 assert.match(app,/unchanged\?former\.idempotency_key/);
 assert.match(server,/OWNER_SESSIONS\.check/);
 assert.match(server,/HttpOnly; SameSite=Strict; Path=\/api\/owner/);
 assert.match(server,/OWNER_SESSIONS\.enabled/);
 assert.match(server,/mpc_owner\.configured_store/);
 assert.match(server,/mpc_owner\.submit_request/);
 assert.doesNotMatch(server,/route\s*==\s*"\/api\/projects\/activate"|route\s*==\s*"\/api\/owner\/dispatch"/);
 assert.match(server,/\/project_request_view\.mjs/);
});


test("Completed POSTs apply only to the same task, submission epoch, and Owner session",()=>{
 const base={submittedTarget:selected,selectedTarget:selected,submittedEpoch:4,currentEpoch:4,authenticated:true};
 assert.equal(isCurrentOwnerSubmission(base),true);
 assert.equal(isCurrentOwnerSubmission({...base,selectedTarget:"supervisor/project-control/MPC-005"}),false);
 assert.equal(isCurrentOwnerSubmission({...base,currentEpoch:5}),false);
 assert.equal(isCurrentOwnerSubmission({...base,authenticated:false}),false);
 assert.equal(isCurrentOwnerSubmission({...base,submittedEpoch:null}),false);
});

// Exercise the real delegated browser handlers, not just a source-code regex.
// A mocked asynchronous request remains in flight while Owner navigates/edits.
async function ownerBrowserFixture(){
 const events={};
 const domElements=new Map();
 for(const id of ["main-content","loading","page-title","page-subtitle",
                   "page-navigation-status","nav-robots","refresh","updated"]){
  domElements.set(id,{id,innerHTML:"",textContent:"",hidden:false,
                      contains:()=>false,querySelector:()=>null,querySelectorAll:()=>[],
                      addEventListener:()=>{}});
 }
 const requests=[];
 let serverSession={schema:"MPC_OWNER_SESSION_V1",
  authenticated:true,login_enabled:true,csrf:"owner-csrf",login_csrf:"loopback-csrf"};
 let catalogueFetch=()=>Promise.resolve({ok:true,json:async()=>catalogue});
 let sessionFetch=()=>Promise.resolve({ok:true,json:async()=>serverSession});
 let logoutFetch=()=>Promise.resolve({ok:true,status:200,json:async()=>({ok:true,authenticated:false})});
 let overviewRequests=0;
 let nextTimer=0;
 const timers=new Map();
 const sandbox={
  console,Promise,Date,Set,URL,AbortController,
  setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},
  clearTimeout:id=>timers.delete(id),
  crypto:{randomUUID:()=> "11111111-1111-4111-8111-111111111111"},
  document:{
   getElementById:id=>domElements.get(id)??null,
   querySelectorAll:()=>[],
   addEventListener:(type,cb)=>{(events[type]??=[]).push(cb);},
   activeElement:null,hidden:false
  },
  location:{pathname:"/projects",origin:"http://127.0.0.1:8781"},
  history:{pushState:()=>{}},
  window:{addEventListener:()=>{},scrollTo:()=>{}},
  setInterval:()=>{},
  renderProjectTree,isSafeProjectCatalogue,isCurrentOwnerSubmission,
  fetch:(url,opts)=>{
   if(url==="/api/projects")return catalogueFetch();
   if(url==="/api/owner/session")return sessionFetch();
   if(url==="/api/owner/logout")return logoutFetch(opts);
   if(url==="/api/overview"){overviewRequests++;return Promise.resolve({ok:false,status:503});}
   if(url==="/api/monitor")return Promise.resolve({ok:false,status:503});
   if(url!=="/api/owner/requests")throw Error("Unexpected fetch: "+url);
   return new Promise((resolve,reject)=>requests.push({resolve,reject,opts}));
  },
  alert:()=>{},confirm:()=>false
 };
 let script=await fs.readFile(new URL("../src/control-center/web/app.js",import.meta.url),"utf8");
 script=script.replace(/^import [^\n]*\n/gm,"");
 assert.doesNotMatch(script,/^import /m);
 assert.match(script,/refresh\(\);\s*$/);
 script=script.replace(/refresh\(\);\s*$/,[
  "globalThis.__ownerHarness={",
  " init({selected,catalogue,description}){",
  "  projectSelected=selected;projectCatalogue=catalogue;",
  "  ownerSession={authenticated:true,login_enabled:true,csrf:'owner-csrf',login_csrf:'loopback-csrf'};",
  "  ownerDraft={description,priority:'NORMAL',screenshots:''};",
  "  latest={robots:[],services:[],coordinator:null};",
  "  renderedPage='projects';projectVisitVerified=true;",
  " },",
  " state(){return JSON.stringify({selected:projectSelected,draft:ownerDraft,receipt:ownerReceipt,",
  "  error:ownerError,pending:ownerPending,epoch:ownerIntentEpoch,authenticated:ownerSession?.authenticated,",
  "  logoutUnconfirmed:ownerLogoutUnconfirmed});},",
  " seedPrivateState({draft,receipt,pending,error}){",
  "  ownerDraft=draft;ownerReceipt=receipt;ownerPending=pending;ownerError=error;",
  " },",
  " refresh(){return refresh();},",
  " html(){return root.innerHTML;},",
  " navigate(page){if(page!=='projects')latest=null;",
  "  location.pathname=page==='home'?'/':page==='projects'?'/projects':'/robot/'+page;",
  "  openPage(page,false);}",
  "};"
 ].join("\n"));
 vm.runInNewContext(script,sandbox,{filename:"app.js",timeout:2000});
 const handler=events.submit.at(-1);
 const focus=events.click.at(-1);
 const input=events.input.at(-1);
 const submit=(task,description)=>{
  const button={disabled:false};
  const form={
   id:"mpc-owner-request-form",dataset:{target:task},isConnected:true,
   querySelector:(id)=>{
    if(id==="button[type=submit]")return button;
    if(id==="#mpc-owner-description")return {value:description};
    if(id==="#mpc-owner-priority")return {value:"NORMAL"};
    if(id==="#mpc-owner-screenshots")return {value:""};
    return null;
   }
  };
  return {run:handler({target:form,preventDefault:()=>{}}),button,form};
 };
 const select=async key=>{
  await focus({target:{closest:kind=>kind==="[data-project-focus]"?
   {dataset:{projectFocus:key}}:null}});
 };
 const edit=description=>input({target:{id:"mpc-owner-description",value:description}});
 const logout=()=>focus({target:{disabled:false,closest:selector=>
   selector==="[data-mpc-owner-logout],[data-mpc-owner-logout-retry]"?{disabled:false}:null}});
 return {harness:sandbox.__ownerHarness,requests,submit,select,edit,logout,
  setServerSession(next){serverSession={schema:"MPC_OWNER_SESSION_V1",...next};},
  setCatalogueFetch(next){catalogueFetch=next;},
  setSessionFetch(next){sessionFetch=next;},
  setLogoutFetch(next){logoutFetch=next;},
  overviewRequestCount(){return overviewRequests;},
  fireTimeouts(ms){
   const entries=[...timers.entries()].filter(([,t])=>t.ms===ms);
   for(const [id,t] of entries){timers.delete(id);t.fn();}
   return entries.length;
  },
 };
}

const taskB="supervisor/project-control/MPC-005";
test("In-flight success for task A never overwrites B's receipt or newly entered draft",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Original request for task A"});
 const pending=ui.submit(selected,"Original request for task A");
 assert.equal(ui.requests.length,1);
 await ui.select(taskB);
 ui.edit("New unsent request for task B must survive");
 ui.requests[0].resolve({ok:true,json:async()=>({
   request_id:"receipt-for-A",status:"PENDING_OWNER_REVIEW",dispatch_authorized:false
 })});
 await pending.run;
 const state=JSON.parse(ui.harness.state());
 assert.equal(state.selected,taskB);
 assert.equal(state.draft.description,"New unsent request for task B must survive");
 assert.equal(state.receipt,null);
 assert.equal(state.error,"");
});

test("In-flight failed POST for task A cannot show stale error over task B",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Original A task request"});
 const pending=ui.submit(selected,"Original A task request");
 await ui.select(taskB);
 ui.edit("B draft typed while A request has no network confirmation");
 ui.requests[0].reject(new Error("Network lost for A"));
 await pending.run;
 const state=JSON.parse(ui.harness.state());
 assert.equal(state.selected,taskB);
 assert.equal(state.draft.description,"B draft typed while A request has no network confirmation");
 assert.equal(state.receipt,null);
 assert.equal(state.error,"");
});

test("A-B-A switch or edit during POST invalidates old A completion",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Original A task request"});
 const pending=ui.submit(selected,"Original A task request");
 await ui.select(taskB);
 await ui.select(selected);
 ui.edit("Fresh A task draft, different from the earlier request");
 ui.requests[0].resolve({ok:true,json:async()=>({
   request_id:"old-A-receipt",status:"PENDING_OWNER_REVIEW",dispatch_authorized:false
 })});
 await pending.run;
 const state=JSON.parse(ui.harness.state());
 assert.equal(state.selected,selected);
 assert.equal(state.draft.description,"Fresh A task draft, different from the earlier request");
 assert.equal(state.receipt,null);
 assert.equal(pending.button.disabled,false);
});


test("Unauthenticated or unprovisioned sessions never display a saved receipt",()=>{
 for(const session of [
   null,
   {authenticated:false,login_enabled:true},
   {authenticated:true,login_enabled:false}
 ]){
  const html=renderOwnerRequestPanel({catalogue,selected,session,
   receipt:{request_id:"private-receipt-from-previous-owner",status:"PENDING_OWNER_REVIEW"}});
  assert.doesNotMatch(html,/private-receipt-from-previous-owner/);
 }
});

test("Session expiration erases draft, prior receipt, retry token and error on server refresh",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Sensitive draft under authenticated session"});
 ui.harness.seedPrivateState({
  draft:{description:"Prior session confidential instructions",priority:"HIGH",screenshots:""},
  receipt:{request_id:"private-receipt",status:"PENDING_OWNER_REVIEW"},
  pending:{target:selected,idempotency_key:"old-token"},error:"Previous private error"
 });
 ui.setServerSession({authenticated:false,login_enabled:true,csrf:null,login_csrf:"loopback-csrf"});
 await ui.harness.refresh();
 let state=JSON.parse(ui.harness.state());
 assert.equal(state.authenticated,false);
 assert.deepEqual(state.draft,{description:"",priority:"NORMAL",screenshots:""});
 assert.equal(state.pending,null);
 assert.equal(state.receipt,null);
 assert.equal(state.error,"");
 // Even a later valid Owner login must NOT recover data from the prior session.
 ui.setServerSession({authenticated:true,login_enabled:true,csrf:"new-owner-csrf",login_csrf:"loopback-csrf"});
 await ui.harness.refresh();
 state=JSON.parse(ui.harness.state());
 assert.equal(state.authenticated,true);
 assert.equal(state.receipt,null);
 assert.equal(state.draft.description,"");
});

test("Session rotation while still authenticated revokes earlier Owner data",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Sensitive previous session"});
 ui.harness.seedPrivateState({
  draft:{description:"Do not reuse this session draft",priority:"NORMAL",screenshots:""},
  receipt:{request_id:"old-owner-receipt"},pending:{target:selected},error:""
 });
 ui.setServerSession({authenticated:true,login_enabled:true,csrf:"rotated-session-csrf",login_csrf:"loopback-csrf"});
 await ui.harness.refresh();
 const state=JSON.parse(ui.harness.state());
 assert.equal(state.authenticated,true);
 assert.equal(state.receipt,null);
 assert.equal(state.pending,null);
 assert.equal(state.draft.description,"");
});

test("A delayed submission response cannot resurrect a receipt after session expiry",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Task A before session expiration"});
 const pending=ui.submit(selected,"Task A before session expiration");
 ui.setServerSession({authenticated:false,login_enabled:true,csrf:null,login_csrf:"loopback-csrf"});
 await ui.harness.refresh();
 ui.requests[0].resolve({ok:true,json:async()=>({
   request_id:"forbidden-late-receipt",status:"PENDING_OWNER_REVIEW",dispatch_authorized:false
 })});
 await pending.run;
 const state=JSON.parse(ui.harness.state());
 assert.equal(state.authenticated,false);
 assert.equal(state.receipt,null);
 assert.equal(state.pending,null);
 assert.equal(state.draft.description,"");
});


test("Failed catalogue and session fetch revoke Owner state independently",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Sensitive Owner draft"});
 ui.harness.seedPrivateState({
  draft:{description:"Confidential previous request",priority:"HIGH",screenshots:""},
  receipt:{request_id:"private-old-owner-receipt"},pending:{target:selected},error:"Old error"
 });
 ui.setCatalogueFetch(()=>Promise.reject(new Error("CATALOGUE_OFFLINE")));
 ui.setSessionFetch(()=>Promise.reject(new Error("OWNER_SESSION_OFFLINE")));
 await ui.harness.refresh();
 let state=JSON.parse(ui.harness.state());
 assert.equal(state.authenticated,false);
 assert.equal(state.receipt,null);
 assert.equal(state.pending,null);
 assert.equal(state.draft.description,"");
 assert.equal(state.error,"");
 // A second malformed probe cannot silently restore the prior private state.
 ui.setSessionFetch(()=>Promise.resolve({ok:true,json:async()=>{throw Error("malformed JSON");}}));
 await ui.harness.refresh();
 state=JSON.parse(ui.harness.state());
 assert.equal(state.authenticated,false);
 assert.equal(state.receipt,null);
});

test("A malformed catalogue cannot bypass session expiry or keep a writable form",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Old private Owner draft"});
 ui.harness.seedPrivateState({
  draft:{description:"Private Owner draft",priority:"NORMAL",screenshots:""},
  receipt:{request_id:"private-id"},pending:{target:selected},error:""
 });
 ui.setCatalogueFetch(()=>Promise.resolve({ok:true,json:async()=>{throw Error("bad project JSON");}}));
 ui.setServerSession({authenticated:false,login_enabled:true,csrf:null,login_csrf:"loopback-csrf"});
 await ui.harness.refresh();
 const state=JSON.parse(ui.harness.state());
 assert.equal(state.authenticated,false);
 assert.equal(state.receipt,null);
 assert.equal(state.pending,null);
 assert.equal(state.draft.description,"");
});

test("Malformed but HTTP-200 Owner session is NOT authenticated",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Sensitive draft"});
 ui.harness.seedPrivateState({
  draft:{description:"Must be erased",priority:"HIGH",screenshots:""},
  receipt:{request_id:"secret-receipt"},pending:{target:selected},error:""
 });
 ui.setSessionFetch(()=>Promise.resolve({ok:true,json:async()=>({
  schema:"FORGED_SESSION",authenticated:true,login_enabled:true,
  csrf:"old-owner-csrf",login_csrf:"loopback-csrf"
 })}));
 await ui.harness.refresh();
 const state=JSON.parse(ui.harness.state());
 assert.equal(state.authenticated,false);
 assert.equal(state.receipt,null);
 assert.equal(state.pending,null);
 assert.equal(state.draft.description,"");
});

test("HTTP 403 logout does not restore authenticated controls or claim success",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Sensitive prior Owner input"});
 ui.harness.seedPrivateState({
  draft:{description:"Sensitive prior Owner input",priority:"HIGH",screenshots:""},
  receipt:{request_id:"owner-receipt"},pending:{target:selected},error:""
 });
 ui.setLogoutFetch(()=>Promise.resolve({ok:false,status:403,json:async()=>({ok:false})}));
 await ui.logout();
 let state=JSON.parse(ui.harness.state());
 assert.equal(state.logoutUnconfirmed,true);
 assert.equal(state.authenticated,false);
 assert.equal(state.receipt,null);
 assert.equal(state.draft.description,"");
 assert.match(state.error,/Chưa xác nhận được đăng xuất/);
 // Server still reports a valid cookie. Refresh must NOT silently unlock Owner.
 await ui.harness.refresh();
 state=JSON.parse(ui.harness.state());
 assert.equal(state.logoutUnconfirmed,true);
 assert.equal(state.authenticated,false);
 assert.equal(state.receipt,null);
 assert.match(renderOwnerRequestPanel({
  catalogue,selected,session:{authenticated:false,login_enabled:false},
  logoutUnconfirmed:true,error:state.error
 }),/data-mpc-owner-logout-retry/);
});

test("Logout network failure keeps interface locked across refresh until acknowledged retry",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Private Owner request"});
 ui.setLogoutFetch(()=>Promise.reject(new Error("NETWORK_OFFLINE")));
 await ui.logout();
 let state=JSON.parse(ui.harness.state());
 assert.equal(state.logoutUnconfirmed,true);
 assert.equal(state.authenticated,false);
 assert.equal(state.receipt,null);
 // Server still reports a valid cookie; refresh must not re-enable Owner.
 await ui.harness.refresh();
 state=JSON.parse(ui.harness.state());
 assert.equal(state.logoutUnconfirmed,true);
 assert.equal(state.authenticated,false);
 // Retry acknowledges revocation only after the server confirms success.
 ui.setLogoutFetch(()=>{
  ui.setServerSession({
   authenticated:false,login_enabled:true,csrf:null,login_csrf:"loopback-csrf"
  });
  return Promise.resolve({ok:true,status:200,json:async()=>({ok:true,authenticated:false})});
 });
 await ui.logout();
 state=JSON.parse(ui.harness.state());
 assert.equal(state.logoutUnconfirmed,false);
 assert.equal(state.authenticated,false);
 assert.equal(state.receipt,null);
});

test("Logout retry stays available even if catalogue is malformed or unavailable",()=>{
 const html=renderOwnerRequestPanel({
  catalogue:{status:"UNAVAILABLE",projects:[]},selected,
  session:{authenticated:false,login_enabled:false},logoutUnconfirmed:true,
  receipt:{request_id:"old-secret"},draft:{description:"confidential"}
 });
 assert.match(html,/data-mpc-owner-logout-retry/);
 assert.doesNotMatch(html,/old-secret|confidential|mpc-owner-request-form/);
});


test("Reject malformed nested project / feature / task arrays before rendering",()=>{
 assert.equal(isSafeProjectCatalogue(catalogue),true);
 const invalid=[
  null,{}, {projects:null},{projects:"not-array"},
  {projects:[null]},
  {projects:[false]},
  {projects:[{id:"supervisor",features:null}]},
  {projects:[{id:"supervisor",features:[null]}]},
  {projects:[{id:"supervisor",features:[{id:"project-control",tasks:[null]}]}]},
  {projects:[{id:"supervisor",features:[{id:"project-control",tasks:[{}]}]}]},
  {projects:[{id:"supervisor",features:[{id:"project-control",tasks:[false]}]}]},
  {projects:[{id:"../../unsafe",features:[]}]},
 ];
 for(const candidate of invalid)
  assert.equal(isSafeProjectCatalogue(candidate),false,
   JSON.stringify(candidate));
});

test("Malformed HTTP-200 nested catalogue cannot leave previous private DOM after session expiry",async()=>{
 const candidates=[
  {projects:[null]},
  {projects:[{id:"supervisor",features:[null]}]},
  {projects:[{id:"supervisor",features:[{id:"project-control",tasks:[null]}]}]},
 ];
 for(const malformed of candidates){
  const ui=await ownerBrowserFixture();
  ui.harness.init({selected,catalogue,description:"Secret Owner input"});
  ui.harness.seedPrivateState({
   draft:{description:"Secret Owner input",priority:"HIGH",screenshots:""},
   receipt:{request_id:"private-old-receipt"},
   pending:{target:selected},error:""
  });
  await ui.harness.refresh();
  assert.match(ui.harness.html(),/private-old-receipt/);
  assert.match(ui.harness.html(),/id="mpc-owner-request-form"/);
  ui.setServerSession({authenticated:false,login_enabled:true,csrf:null,login_csrf:"loopback-csrf"});
  ui.setCatalogueFetch(()=>Promise.resolve({ok:true,json:async()=>malformed}));
  await ui.harness.refresh();
  const state=JSON.parse(ui.harness.state());
  assert.equal(state.authenticated,false);
  assert.equal(state.receipt,null);
  assert.equal(state.draft.description,"");
  assert.doesNotMatch(ui.harness.html(),/private-old-receipt|Secret Owner input|id="mpc-owner-request-form"/);
  assert.match(ui.harness.html(),/Không đọc được danh mục|Không thể xác minh danh mục/);
 }
});

test("Renderer failure itself also removes a previously displayed authenticated Owner form",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Private user text"});
 ui.harness.seedPrivateState({
  draft:{description:"Private user text",priority:"NORMAL",screenshots:""},
  receipt:{request_id:"private-receipt"},pending:{target:selected},error:""
 });
 await ui.harness.refresh();
 assert.match(ui.harness.html(),/private-receipt/);
 // Simulate a catalogue node that throws from a non-data render function
 // after validation. App's render boundary still replaces old DOM and locks.
 ui.harness.init({selected,catalogue:{...catalogue,projects:[{id:"supervisor",
  get title(){throw Error("untrusted title getter");},
  features:catalogue.projects[0].features}]},description:"Private user text"});
 ui.harness.seedPrivateState({
  draft:{description:"Private user text",priority:"NORMAL",screenshots:""},
  receipt:{request_id:"private-receipt"},pending:{target:selected},error:""
 });
 // openPage invoked by click selecting already known task on current catalogue
 // with bad title. It must not leave old DOM from the previous render.
 await ui.select(selected);
 const state=JSON.parse(ui.harness.state());
 assert.equal(state.authenticated,false);
 assert.equal(state.receipt,null);
 assert.doesNotMatch(ui.harness.html(),/private-receipt|id="mpc-owner-request-form"/);
});


test("Only exact trusted navigation status can enable an Owner task form",()=>{
 assert.equal(isSafeProjectCatalogue(catalogue),true);
 for(const broken of [
  {...catalogue,status:undefined},
  {...catalogue,status:"READY"},
  {...catalogue,status:"VERIFIED_DONE"},
  {...catalogue,status:"UNAVAILABLE"},
  {...catalogue,status:null},
 ]){
  assert.equal(isSafeProjectCatalogue(broken),false,String(broken.status));
 }
 assert.equal(isSafeProjectCatalogue({status:"UNAVAILABLE",projects:[]}),true);
});

test("Untrusted or unavailable catalogue status never renders an authenticated Owner request form",async()=>{
 for(const status of ["READY","UNAVAILABLE",null,undefined]){
  const ui=await ownerBrowserFixture();
  ui.harness.init({selected,catalogue,description:"Private Owner draft"});
  ui.harness.seedPrivateState({
   draft:{description:"Private Owner draft",priority:"HIGH",screenshots:""},
   receipt:{request_id:"private-owner-receipt"},pending:{target:selected},error:""
  });
  await ui.harness.refresh();
  assert.match(ui.harness.html(),/id="mpc-owner-request-form"/);
  ui.setCatalogueFetch(()=>Promise.resolve({ok:true,json:async()=>({...catalogue,status})}));
  await ui.harness.refresh();
  assert.doesNotMatch(ui.harness.html(),/id="mpc-owner-request-form"|private-owner-receipt|Private Owner draft/);
  assert.match(ui.harness.html(),/Không đọc được danh mục/);
 }
});

test("Navigating back to Projects never renders cached Owner data before a fresh probe",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Prior Owner request"});
 ui.harness.seedPrivateState({
  draft:{description:"Sensitive Owner draft from prior visit",priority:"HIGH",screenshots:""},
  receipt:{request_id:"secret-prior-receipt"},pending:{target:selected},error:""
 });
 await ui.harness.refresh();
 assert.match(ui.harness.html(),/secret-prior-receipt/);
 // Switching pages invalidates the Owner capability and removes old data.
 ui.harness.navigate("home");
 ui.harness.navigate("projects");
 assert.match(ui.harness.html(),/Đang xác minh lại quyền Owner/);
 assert.doesNotMatch(ui.harness.html(),/secret-prior-receipt|Sensitive Owner draft|mpc-owner-request-form/);
 let completeSession;
 let sessionProbeNumber=0;
 ui.setSessionFetch(()=>++sessionProbeNumber===1
  ?new Promise(resolve=>{completeSession=resolve;})
  :Promise.resolve({ok:true,json:async()=>({
    schema:"MPC_OWNER_SESSION_V1",authenticated:false,login_enabled:true,
    login_csrf:"loopback-csrf",csrf:null
   })}));
 const pending=ui.harness.refresh();
 assert.match(ui.harness.html(),/Đang xác minh lại quyền Owner/);
 assert.doesNotMatch(ui.harness.html(),/secret-prior-receipt|mpc-owner-request-form/);
 completeSession({ok:true,json:async()=>({
  schema:"MPC_OWNER_SESSION_V1",authenticated:false,login_enabled:true,
  login_csrf:"loopback-csrf",csrf:null
 })});
 await pending;
 const state=JSON.parse(ui.harness.state());
 assert.equal(state.authenticated,false);
 assert.equal(state.receipt,null);
 assert.equal(state.draft.description,"");
 assert.doesNotMatch(ui.harness.html(),/secret-prior-receipt|mpc-owner-request-form/);
});

test("A delayed response from an earlier Project visit cannot unlock its later visit",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Old Owner request"});
 let completeOld;
 ui.setSessionFetch(()=>new Promise(resolve=>{completeOld=resolve;}));
 const oldRefresh=ui.harness.refresh();
 ui.harness.navigate("home");
 ui.harness.navigate("projects");
 assert.match(ui.harness.html(),/Đang xác minh lại quyền Owner/);
 completeOld({ok:true,json:async()=>({
  schema:"MPC_OWNER_SESSION_V1",authenticated:true,login_enabled:true,
  login_csrf:"loopback-csrf",csrf:"owner-csrf"
 })});
 await oldRefresh;
 // Old verification belongs to a previous visit and must be discarded.
 assert.doesNotMatch(ui.harness.html(),/mpc-owner-request-form/);
});


test("Authenticated Owner always has a logout control without a selected task",()=>{
 const session={authenticated:true,login_enabled:true,csrf:"verified-csrf"};
 for(const current of ["", "supervisor", "supervisor/project-control",
                      "supervisor/project-control/NOT-A-TASK"]){
  const html=renderOwnerRequestPanel({catalogue,selected:current,session});
  assert.match(html,/data-mpc-owner-logout/);
  assert.doesNotMatch(html,/id="mpc-owner-request-form"/);
 }
 const unavailable={status:"UNAVAILABLE",projects:[]};
 const html=renderProjectTree({catalogue:unavailable,selected,
  ownerRequest:{session}});
 assert.match(html,/data-mpc-owner-logout/);
 assert.doesNotMatch(html,/mpc-owner-request-form/);
 const pending=renderOwnerRequestPanel({catalogue:unavailable,selected,session,
  logoutUnconfirmed:true});
 assert.match(pending,/data-mpc-owner-logout-retry/);
});

test("In-place poll masks Owner fields immediately, and expiry is processed before stalled catalogue",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Private draft of last Owner"});
 ui.harness.seedPrivateState({
  draft:{description:"Confidential old Owner request",priority:"HIGH",screenshots:""},
  receipt:{request_id:"private-receipt"},pending:{target:selected},error:""
 });
 await ui.harness.refresh();
 assert.match(ui.harness.html(),/private-receipt/);
 let resolveCatalogue;
 ui.setCatalogueFetch(()=>new Promise(resolve=>{resolveCatalogue=resolve;}));
 ui.setServerSession({authenticated:false,login_enabled:true,csrf:null,login_csrf:"loopback-csrf"});
 const poll=ui.harness.refresh();
 // Masking must occur synchronously before ANY async session/catalogue fetch.
 assert.doesNotMatch(ui.harness.html(),/private-receipt|Confidential old Owner request|mpc-owner-request-form/);
 assert.match(ui.harness.html(),/Đang xác minh lại quyền Owner/);
 // Allow independent session JSON parsing while catalogue is still unsettled.
 for(let i=0;i<12;i++)await Promise.resolve();
 const expired=JSON.parse(ui.harness.state());
 assert.equal(expired.authenticated,false);
 assert.equal(expired.receipt,null);
 assert.equal(expired.pending,null);
 assert.equal(expired.draft.description,"");
 assert.doesNotMatch(ui.harness.html(),/private-receipt|mpc-owner-request-form/);
 resolveCatalogue({ok:true,json:async()=>catalogue});
 await poll;
 assert.doesNotMatch(ui.harness.html(),/private-receipt|mpc-owner-request-form/);
});

test("Logout remains available during a stalled catalogue poll",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected:"supervisor",catalogue,description:""});
 await ui.harness.refresh();
 ui.harness.navigate("projects");
 let resolveCatalogue;
 ui.setCatalogueFetch(()=>new Promise(resolve=>{resolveCatalogue=resolve;}));
 const poll=ui.harness.refresh();
 assert.match(ui.harness.html(),/data-mpc-owner-logout/);
 assert.doesNotMatch(ui.harness.html(),/mpc-owner-request-form/);
 resolveCatalogue({ok:true,json:async()=>catalogue});
 await poll;
 assert.match(ui.harness.html(),/data-mpc-owner-logout/);
 assert.doesNotMatch(ui.harness.html(),/mpc-owner-request-form/);
});


test("Revalidate Owner AFTER catalogue wait; an expired session cannot restore a private form",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Sensitive old request"});
 ui.harness.seedPrivateState({
  draft:{description:"Private previous Owner instructions",priority:"HIGH",screenshots:""},
  receipt:{request_id:"previous-owner-receipt"},pending:{target:selected},error:""
 });
 let releaseCatalogue;
 ui.setCatalogueFetch(()=>new Promise(resolve=>{releaseCatalogue=resolve;}));
 let checked=0;
 ui.setSessionFetch(()=>Promise.resolve({ok:true,json:async()=>{
  checked++;
  return {schema:"MPC_OWNER_SESSION_V1",
    authenticated:checked===1,login_enabled:true,
    login_csrf:"loopback-csrf",csrf:checked===1?"owner-csrf":null};
 }}));
 const refreshing=ui.harness.refresh();
 for(let i=0;i<20;i++)await Promise.resolve();
 assert.equal(checked,1,"First session must be processed while the catalogue is pending");
 assert.doesNotMatch(ui.harness.html(),/previous-owner-receipt|mpc-owner-request-form/);
 releaseCatalogue({ok:true,json:async()=>catalogue});
 await refreshing;
 assert.equal(checked,2,"Owner session must be re-probed after the catalogue resolves");
 const state=JSON.parse(ui.harness.state());
 assert.equal(state.authenticated,false);
 assert.equal(state.receipt,null);
 assert.equal(state.pending,null);
 assert.equal(state.draft.description,"");
 assert.doesNotMatch(ui.harness.html(),/previous-owner-receipt|Private previous Owner instructions|mpc-owner-request-form/);
});

test("Catalogue hard timeout releases Projects refresh without unlocking old Owner state",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Old session draft"});
 ui.harness.seedPrivateState({
  draft:{description:"Old Owner draft",priority:"NORMAL",screenshots:""},
  receipt:{request_id:"old-secret-receipt"},pending:null,error:""
 });
 ui.setCatalogueFetch(()=>new Promise(()=>{})); // ignores even AbortSignal
 let sessionProbes=0;
 ui.setSessionFetch(()=>Promise.resolve({ok:true,json:async()=>({
  schema:"MPC_OWNER_SESSION_V1",authenticated:++sessionProbes===1,
  login_enabled:true,login_csrf:"loopback-csrf",csrf:sessionProbes===1?"owner-csrf":null
 })}));
 const pending=ui.harness.refresh();
 for(let i=0;i<20;i++)await Promise.resolve();
 assert.equal(ui.fireTimeouts(8000),1);
 await pending;
 assert.equal(sessionProbes,2);
 const state=JSON.parse(ui.harness.state());
 assert.equal(state.authenticated,false);
 assert.equal(state.receipt,null);
 assert.doesNotMatch(ui.harness.html(),/old-secret-receipt|mpc-owner-request-form/);
});

test("Leaving a permanently hung Projects fetch frees the shared refresh lock immediately",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Private Owner data"});
 let startedCatalogue=0;
 ui.setCatalogueFetch(()=>{
  startedCatalogue++;
  return new Promise(()=>{}); // abort-ignoring simulated web stack
 });
 const stuck=ui.harness.refresh();
 for(let i=0;i<20;i++)await Promise.resolve();
 assert.equal(startedCatalogue,1);
 ui.harness.navigate("home");
 await stuck; // MUST complete without resolving the fetch or waiting for timeout
 // A pending refresh is automatically scheduled for the new destination.
 for(let i=0;i<15;i++)await Promise.resolve();
 assert.ok(ui.overviewRequestCount()>0,"Home overview must run after leaving Projects");
 // Subsequent refresh attempts are no longer blocked by stale Projects busy.
 const before=ui.overviewRequestCount();
 await ui.harness.refresh();
 assert.ok(ui.overviewRequestCount()>before);
});

test("Owner-session fetch itself has a deadline even if the transport ignores cancellation",async()=>{
 const ui=await ownerBrowserFixture();
 ui.harness.init({selected,catalogue,description:"Earlier Owner data"});
 ui.harness.seedPrivateState({
  draft:{description:"Earlier Owner data",priority:"NORMAL",screenshots:""},
  receipt:{request_id:"older-id"},pending:{target:selected},error:""
 });
 ui.setSessionFetch(()=>new Promise(()=>{}));
 const pending=ui.harness.refresh();
 for(let i=0;i<12;i++)await Promise.resolve();
 assert.equal(ui.fireTimeouts(5000),1);
 for(let i=0;i<12;i++)await Promise.resolve();
 assert.equal(ui.fireTimeouts(5000),1,"Final re-probe also has a hard deadline");
 await pending;
 const state=JSON.parse(ui.harness.state());
 assert.equal(state.authenticated,false);
 assert.equal(state.receipt,null);
 assert.doesNotMatch(ui.harness.html(),/older-id|mpc-owner-request-form/);
});
