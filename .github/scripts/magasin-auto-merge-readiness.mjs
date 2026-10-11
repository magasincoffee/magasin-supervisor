// G1 pilot: GitHub read-only readiness snapshot. Never uses POST/PATCH/PUT/DELETE.
import {assessAutoMergeGate, REQUIRED_CI} from "./magasin-auto-merge-policy.mjs";
const token=process.env.GITHUB_TOKEN, repo=process.env.GITHUB_REPOSITORY;
if(!token || !/^magasincoffee\/magasin-supervisor$/.test(repo||"")) { console.error("UNQUALIFIED_READONLY_CONTEXT"); process.exitCode=1; }
else {
  const headers={Authorization:"Bearer "+token,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"};
  async function api(path) {
    const r=await fetch("https://api.github.com"+path,{method:"GET",headers,signal:AbortSignal.timeout(12000)});
    if(!r.ok) throw Error("GITHUB_HTTP_"+r.status+"_"+path.split("?")[0]);
    return r.json();
  }
  async function graphql(query,variables) {
    const r=await fetch("https://api.github.com/graphql",{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(12000)});
    // GitHub GraphQL is READ-ONLY query; never mutate.
    if(!r.ok) throw Error("GRAPHQL_HTTP_"+r.status);
    const data=await r.json(); if(data.errors?.length) throw Error("GRAPHQL_QUERY_FAILED");
    return data.data;
  }
  try {
    const owner="magasincoffee",name="magasin-supervisor";
    const repoMeta=await api("/repos/"+repo);
    const prList=await api("/repos/"+repo+"/pulls?state=open&per_page=100");
    if(prList.length===100)throw Error("PR_LIST_PAGE_LIMIT");
    const candidates=prList.filter(p=>p.labels?.some(l=>l.name==="magasin-auto-merge-eligible")).slice(0,20);
    if(candidates.length===20)throw Error("CANDIDATE_LIST_LIMIT");
    let branchProtectionPassed=false;
    try {
      const protection=await api("/repos/"+repo+"/branches/main/protection");
      branchProtectionPassed=!!(protection.required_status_checks && protection.required_pull_request_reviews);
    } catch { /* unavailable metadata => HOLD */ }
    for(const p of candidates) {
      const number=p.number;
      try {
        const [files,allReviews,runs,comments,threadResponse]=await Promise.all([
          api("/repos/"+repo+"/pulls/"+number+"/files?per_page=100"),
          api("/repos/"+repo+"/pulls/"+number+"/reviews?per_page=100"),
          api("/repos/"+repo+"/actions/runs?head_sha="+p.head.sha+"&per_page=100"),
          api("/repos/"+repo+"/issues/"+number+"/comments?per_page=100"),
          graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage}nodes{isResolved}}}}}`,{owner,name,number})
        ]);
        if([files,allReviews,comments].some(a=>a.length===100)||runs.total_count>100)throw Error("INCOMPLETE_PAGINATION");
        const threads=threadResponse?.repository?.pullRequest?.reviewThreads;
        if(!threads || threads.pageInfo.hasNextPage)throw Error("REVIEW_THREAD_PAGINATION");
        const codexSummary=comments.some(c=>c.user?.login==="chatgpt-codex-connector[bot]" && c.body?.includes("✅ **Completed**") && c.body?.includes(p.head.sha.slice(0,7)));
        const hasCodexReview=allReviews.some(r=>r.user?.login?.startsWith("chatgpt-codex-connector") && r.commit_id===p.head.sha);
        const unresolvedThreads=threads.nodes.filter(x=>!x.isResolved).length;
        const result=assessAutoMergeGate({
          files:files.map(x=>x.filename),headSha:p.head.sha,base:p.base.ref,state:p.state,draft:p.draft,author:p.user?.login,
          explicitDelegation:true,
          ciRuns:runs.workflow_runs.filter(x=>REQUIRED_CI.includes(x.name)).map(x=>({name:x.name,headSha:x.head_sha,status:x.status,conclusion:x.conclusion})),
          aiReview:{provider:"chatgpt-codex-connector",completed:codexSummary&&hasCodexReview,headSha:p.head.sha,unresolvedThreads,reviewHasFindings:unresolvedThreads>0},
          approvals:allReviews.filter(r=>r.state==="APPROVED").map(r=>({author:r.user?.login,headSha:r.commit_id,state:r.state})),
          changesRequested:allReviews.some(r=>r.state==="CHANGES_REQUESTED"),
          branchProtectionPassed,autoMergeEnabled:repoMeta.allow_auto_merge===true,
          releaseOrStartRequested:false
        });
        console.log(JSON.stringify({pr:number,headSha:p.head.sha,stage:"G1_READ_ONLY",...result}));
      }catch(e){console.log(JSON.stringify({pr:number,stage:"G1_READ_ONLY",decision:"HOLD",reasons:["READ_EVIDENCE_FAILED_CLOSED",String(e.message).slice(0,110)]}));}
    }
    console.log(JSON.stringify({stage:"G1_READ_ONLY",candidates:candidates.length,merge_actions:0,supervisor_start_actions:0}));
  }catch(e){console.error("READINESS_FAILED_CLOSED",e.message);process.exitCode=1;}
}
