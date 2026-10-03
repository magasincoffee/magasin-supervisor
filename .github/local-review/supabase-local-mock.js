(()=>{'use strict';
const SESSION_KEY='magasin.local.staging.session.v1';
const DATA_KEY='magasin.local.staging.data.v1';
const PASSWORD='Magasin123!';
const accounts=[
 {id:'local-owner',username:'owner',email:'owner@magasin.local',password:PASSWORD,profile:{id:'local-owner',username:'owner',full_name:'Owner Review',role:'OWNER',status:'ACTIVE',access_scope:'ALL'}},
 {id:'local-manager',username:'manager',email:'manager@magasin.local',password:PASSWORD,profile:{id:'local-manager',username:'manager',full_name:'Quản lý Review',role:'STORE_MANAGER',status:'ACTIVE',access_scope:'STORE'}},
 {id:'local-employee',username:'employee',email:'employee@magasin.local',password:PASSWORD,profile:{id:'local-employee',username:'employee',full_name:'Nhân viên Review',role:'STAFF',status:'ACTIVE',access_scope:'SELF'}}
];
const stores=[
 {id:'store-a',code:'CN-QA-A',name:'Cửa hàng QA A',status:'ACTIVE'},
 {id:'store-b',code:'CN-QA-B',name:'Cửa hàng QA B',status:'ACTIVE'},
 {id:'store-c',code:'CN-QA-C',name:'Cửa hàng QA C',status:'ACTIVE'},
 {id:'store-d',code:'CN-QA-D',name:'Cửa hàng QA D',status:'ACTIVE'}
];
const staff=[
 {id:'u-1',full_name:'An Nguyễn',username:'an.nguyen'},
 {id:'u-2',full_name:'Bình Trần',username:'binh.tran'},
 {id:'u-3',full_name:'Chi Lê',username:'chi.le'},
 {id:'local-employee',full_name:'Nhân viên Review',username:'employee'}
];
const clone=v=>v==null?v:JSON.parse(JSON.stringify(v));
const iso=d=>d.toISOString().slice(0,10);
const dateUtc=k=>new Date(String(k).slice(0,10)+'T00:00:00Z');
const add=(k,n)=>{const d=dateUtc(k);d.setUTCDate(d.getUTCDate()+n);return iso(d)};
const monday=(k)=>{const d=dateUtc(k||iso(new Date()));const day=d.getUTCDay()||7;d.setUTCDate(d.getUTCDate()-(day-1));return iso(d)};
function loadState(){
 try{const x=JSON.parse(localStorage.getItem(DATA_KEY)||'null');if(x&&x.version===2)return x}catch(_){}
 const week=monday();
 const state={version:2,generations:{},assignments:{},availability:[],employeeAvailability:[],official:[]};
 const statuses=['DRAFT','REVIEWED','PUBLISHED',null];
 stores.forEach((s,idx)=>{
   if(!statuses[idx])return;
   const id='gen-'+s.id+'-'+week;
   state.generations[s.id+'|'+week]={id,store_id:s.id,week_start:week,status:statuses[idx],algorithm_version:'MANAGER_DIRECT_V1'};
   state.assignments[id]=[
     {id:id+'-1',generation_id:id,user_id:'u-1',employee_name:'An Nguyễn',username:'an.nguyen',work_date:add(week,0),start_time:'06:00',end_time:'12:00',store_id:s.id,status:'DRAFT'},
     {id:id+'-2',generation_id:id,user_id:'u-2',employee_name:'Bình Trần',username:'binh.tran',work_date:add(week,1),start_time:'12:00',end_time:'17:00',store_id:s.id,status:'DRAFT'},
     {id:id+'-3',generation_id:id,user_id:'u-3',employee_name:'Chi Lê',username:'chi.le',work_date:add(week,2),start_time:'17:00',end_time:'22:00',store_id:s.id,status:'DRAFT'}
   ];
 });
 stores.forEach((s,si)=>{
   const times=[['06:00','22:00'],['12:00','17:00'],['17:00','22:00']];
   times.forEach((t,i)=>state.availability.push({
     availability_id:'av-'+s.id+'-'+i,user_id:staff[i].id,employee_name:staff[i].full_name,username:staff[i].username,
     work_date:add(week,i),start_time:t[0],end_time:t[1],preferred_store_id:s.id,preferred_store_code:s.code,availability_type:i===1?'PREFERRED':'AVAILABLE'
   }));
 });
 for(let i=0;i<6;i++)state.official.push({
   schedule_id:'sch-'+i,user_id:'local-employee',employee_id:'local-employee',work_date:add(week,i),
   start_time:i%3===0?'06:00':i%3===1?'12:00':'17:00',end_time:i%3===0?'12:00':i%3===1?'17:00':'22:00',
   store_id:'store-a',store_code:'CN-QA-A',store_name:'Cửa hàng QA A',status:'APPROVED'
 });
 const next=add(week,7);
 state.employeeAvailability=[
   {id:'emp-av-1',work_date:add(next,0),start_time:'06:00',end_time:'12:00',availability_type:'AVAILABLE'},
   {id:'emp-av-2',work_date:add(next,2),start_time:'12:00',end_time:'17:00',availability_type:'AVAILABLE'},
   {id:'emp-av-3',work_date:add(next,4),start_time:'17:00',end_time:'22:00',availability_type:'AVAILABLE'}
 ];
 localStorage.setItem(DATA_KEY,JSON.stringify(state));return state;
}
function saveState(s){localStorage.setItem(DATA_KEY,JSON.stringify(s))}
function session(){try{return JSON.parse(localStorage.getItem(SESSION_KEY)||'null')}catch(_){return null}}
function setSession(v){if(v)localStorage.setItem(SESSION_KEY,JSON.stringify(v));else localStorage.removeItem(SESSION_KEY)}
function accountBySession(){const s=session();return accounts.find(a=>a.id===s?.user?.id)||null}
function profile(){return clone(accountBySession()?.profile||null)}
function rowsFor(table){
 if(table==='profiles')return accounts.map(a=>clone({...a.profile,email:a.email}));
 if(table==='stores')return clone(stores);
 return [];
}
function tableQuery(table){
 let rows=rowsFor(table),limitN=null;
 const api={
   select(){return proxy},
   eq(k,v){rows=rows.filter(r=>String(r?.[k])===String(v));return proxy},
   neq(k,v){rows=rows.filter(r=>String(r?.[k])!==String(v));return proxy},
   in(k,vals){const s=new Set((vals||[]).map(String));rows=rows.filter(r=>s.has(String(r?.[k])));return proxy},
   order(k,opt={}){rows.sort((a,b)=>String(a?.[k]??'').localeCompare(String(b?.[k]??''))*(opt.ascending===false?-1:1));return proxy},
   limit(n){limitN=Number(n)||null;return proxy},
   single:async()=>({data:clone((limitN?rows.slice(0,limitN):rows)[0]||null),error:rows.length?null:{message:'ROW_NOT_FOUND'}}),
   maybeSingle:async()=>({data:clone((limitN?rows.slice(0,limitN):rows)[0]||null),error:null}),
   then(resolve,reject){return Promise.resolve({data:clone(limitN?rows.slice(0,limitN):rows),error:null}).then(resolve,reject)}
 };
 const proxy=new Proxy(api,{get(t,p){if(p in t)return t[p];return (..._args)=>proxy}});
 return proxy;
}
function accessibleStores(){
 const p=profile();if(!p)return [];
 if(p.role==='OWNER')return clone(stores);
 if(p.role==='STORE_MANAGER')return clone([stores[0]]);
 return [];
}
function weeklyAvailability(storeId,week){
 const state=loadState(),end=add(week,6);
 return state.availability.filter(r=>String(r.preferred_store_id)===String(storeId)&&r.work_date>=week&&r.work_date<=end);
}
function employeeSchedules(week){
 const state=loadState(),end=add(week,6);
 return state.official.filter(r=>r.work_date>=week&&r.work_date<=end).map(clone);
}
async function rpc(name,args={}){
 const state=loadState();
 if(name==='resolve_login_email'){
   const a=accounts.find(x=>x.username.toLowerCase()===String(args.p_username||'').toLowerCase());
   return {data:a?.email||null,error:null};
 }
 if(name==='get_manager_accessible_stores')return {data:accessibleStores(),error:null};
 if(name==='get_manager_weekly_availability')return {data:clone(weeklyAvailability(args.p_store_id,args.p_week_start)),error:null};
 if(name==='list_schedule_generations'){
   const g=state.generations[String(args.p_store_id)+'|'+String(args.p_week_start)];
   return {data:g?[clone(g)]:[],error:null};
 }
 if(name==='get_schedule_generation_assignments')return {data:clone(state.assignments[String(args.p_generation_id)]||[]),error:null};
 if(name==='get_manager_weekly_schedule'){
   const end=add(args.p_week_start,6);
   return {data:clone(state.official.filter(r=>r.store_id===args.p_store_id&&r.work_date>=args.p_week_start&&r.work_date<=end)),error:null};
 }
 if(name==='create_schedule_generation'){
   const key=String(args.p_store_id)+'|'+String(args.p_week_start);
   let g=state.generations[key];
   if(!g){const id='gen-'+args.p_store_id+'-'+args.p_week_start;g={id,store_id:args.p_store_id,week_start:args.p_week_start,status:'DRAFT',algorithm_version:'MANAGER_DIRECT_V1'};state.generations[key]=g;state.assignments[id]=[];saveState(state)}
   return {data:g.id,error:null};
 }
 if(name==='replace_schedule_generation_assignments'){
   const id=String(args.p_generation_id),list=Array.isArray(args.p_assignments)?args.p_assignments:[];
   state.assignments[id]=list.map((r,i)=>({...clone(r),id:id+'-'+(i+1),generation_id:id,status:'DRAFT'}));saveState(state);
   return {data:list.length,error:null};
 }
 if(name==='validate_schedule_generation_v1')return {data:{valid:true,violations:[],warnings:[]},error:null};
 if(name==='review_schedule_generation'){
   const id=String(args.p_generation_id),g=Object.values(state.generations).find(x=>x.id===id);if(g){g.status='REVIEWED';saveState(state)}
   return {data:{status:'REVIEWED',already_reviewed:false},error:null};
 }
 if(name==='publish_schedule_generation'){
   const id=String(args.p_generation_id),g=Object.values(state.generations).find(x=>x.id===id);if(g){g.status='PUBLISHED';saveState(state)}
   return {data:{published:true,status:'PUBLISHED',already_published:false,inserted_schedule_count:(state.assignments[id]||[]).length,validation:{valid:true,violations:[],warnings:[]}},error:null};
 }
 if(name==='list_my_approved_schedules_v2')return {data:employeeSchedules(args.p_week_start||monday()),error:null};
 if(name==='get_my_availability')return {data:clone(state.employeeAvailability),error:null};
 if(name==='save_my_availability'){
   const id='emp-av-'+Date.now();state.employeeAvailability.push({id,work_date:args.p_work_date,start_time:args.p_start_time,end_time:args.p_end_time,availability_type:args.p_availability_type||'AVAILABLE'});saveState(state);return {data:id,error:null};
 }
 if(name==='delete_my_availability'){state.employeeAvailability=state.employeeAvailability.filter(r=>String(r.id)!==String(args.p_availability_id));saveState(state);return {data:true,error:null}}
 if(name==='get_my_employee_workforce_profile_v1')return {data:[{employee_id:'local-employee',full_name:'Nhân viên Review',username:'employee',phone:'0900000000',employee_role:'STAFF',profile_status:'ACTIVE',primary_store_id:'store-a',primary_store_code:'CN-QA-A',primary_store_name:'Cửa hàng QA A',priority_store_codes:['CN-QA-A'],skill_level:2,join_date:'2026-01-15'}],error:null};
 if(name==='get_my_payroll_self_check_v1')return {data:[{payroll_entry_id:'pay-local-1',period_start:add(monday(),-14),period_end:add(monday(),-8),payroll_revision:'R1',state:'FINALIZED',confirmed_work_item_count:6,confirmed_work_minutes:2160,gross_amount:1800000,net_amount:1800000}],error:null};
 if(name==='get_my_attendance_v2')return {data:[],error:null};
 if(name==='submit_manual_time_attendance_v1')return {data:{id:'att-local-'+Date.now(),status:'SUBMITTED'},error:null};
 if(name==='list_my_notifications_v1')return {data:[{id:'notice-1',event_type:'SCHEDULE_PUBLISHED',title:'Lịch tuần đã được phát hành',message:'Lịch làm mẫu cho tuần hiện tại đã sẵn sàng để review.',created_at:new Date().toISOString()}],error:null};
 if(['list_my_shift_swaps_v2','list_my_incoming_shift_swaps_v1','list_my_shift_gives_v1','get_cross_store_weekly_plan_v1','get_cross_store_weekly_availability_v1'].includes(name))return {data:[],error:null};
 if(['respond_shift_swap_request','respond_shift_give_request'].includes(name))return {data:{ok:true},error:null};
 return {data:[],error:null};
}
const authListeners=new Set();
const client={
 auth:{
   async getSession(){return {data:{session:clone(session())},error:null}},
   async getUser(){const s=session();return {data:{user:clone(s?.user||null)},error:null}},
   onAuthStateChange(cb){authListeners.add(cb);return {data:{subscription:{unsubscribe(){authListeners.delete(cb)}}}}},
   async signInWithPassword({email,password}){
     const a=accounts.find(x=>x.email.toLowerCase()===String(email||'').toLowerCase()&&x.password===password);
     if(!a)return {data:{user:null,session:null},error:{message:'INVALID_LOGIN_CREDENTIALS'}};
     const s={access_token:'local-staging-token',user:{id:a.id,email:a.email,user_metadata:{username:a.username,full_name:a.profile.full_name}}};setSession(s);for(const cb of authListeners)try{cb('SIGNED_IN',clone(s))}catch(_){}
     return {data:{user:clone(s.user),session:clone(s)},error:null};
   },
   async signOut(){setSession(null);for(const cb of authListeners)try{cb('SIGNED_OUT',null)}catch(_){};return {error:null}},
   async updateUser(){return {data:{user:clone(session()?.user||null)},error:null}},
   async resetPasswordForEmail(){return {data:{},error:null}},
   async signUp(){return {data:{user:null,session:null},error:{message:'LOCAL_STAGING_SIGNUP_DISABLED'}}},
   async exchangeCodeForSession(){return {data:{session:null},error:{message:'LOCAL_STAGING'}}},
   async verifyOtp(){return {data:{session:null},error:{message:'LOCAL_STAGING'}}}
 },
 from:tableQuery,
 rpc
};
globalThis.supabase={createClient(){return client}};
globalThis.__MAGASIN_LOCAL_STAGING__={accounts:accounts.map(a=>({username:a.username,email:a.email,password:PASSWORD,role:a.profile.role})),reset(){localStorage.removeItem(DATA_KEY);localStorage.removeItem(SESSION_KEY);location.reload()}};
function banner(){
 if(document.getElementById('localStagingBanner'))return;
 const b=document.createElement('div');b.id='localStagingBanner';b.textContent='LOCAL STAGING · DỮ LIỆU MẪU · KHÔNG GHI PRODUCTION';
 b.style.cssText='position:fixed;right:10px;top:8px;z-index:2147483647;background:#7c2d12;color:#fff;padding:6px 10px;border-radius:999px;font:700 11px/1.2 system-ui;box-shadow:0 3px 12px #0003;pointer-events:none';document.documentElement.appendChild(b);
}
function loginHelpers(){
 const form=document.getElementById('loginForm');if(!form||document.getElementById('localStagingAccounts'))return;
 const box=document.createElement('div');box.id='localStagingAccounts';box.style.cssText='margin:12px 0;padding:12px;border:1px solid #f0c9a8;border-radius:12px;background:#fff8f1';
 box.innerHTML='<b style="display:block;margin-bottom:8px">Tài khoản local staging</b><div style="display:flex;gap:7px;flex-wrap:wrap"></div><div style="margin-top:7px;font-size:11px;color:#7c5a45">Mật khẩu chung: <b>Magasin123!</b> · dữ liệu mẫu, không phải production.</div>';
 const row=box.querySelector('div');
 for(const a of accounts){
   const btn=document.createElement('button');btn.type='button';btn.textContent=a.profile.role==='OWNER'?'Đăng nhập Owner':a.profile.role==='STORE_MANAGER'?'Đăng nhập Manager':'Đăng nhập Employee';
   btn.style.cssText='border:1px solid #d8a875;background:#fff;border-radius:9px;padding:8px 10px;font-weight:700;cursor:pointer';
   btn.addEventListener('click',()=>{const u=document.getElementById('username'),p=document.getElementById('password');if(u)u.value=a.username;if(p)p.value=PASSWORD;form.requestSubmit()});row.appendChild(btn);
 }
 form.parentNode?.insertBefore(box,form);
}
const boot=()=>{banner();loginHelpers()};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();