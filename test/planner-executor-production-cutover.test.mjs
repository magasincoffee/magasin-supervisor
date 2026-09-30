import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildProductionPlannerBootstrap,
  preparePlannerExecutorProductionCutover
} from "../src/runtime/planner-executor-cutover.mjs";

const PLANNER = "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111";
const EXECUTOR = "https://chatgpt.com/c/22222222-2222-2222-2222-222222222222";

function legacyFixture() {
  return {
    config: {
      schema_version: "three-lane-config.v1",
      mode: "THREE_LANE_V1",
      lanes: [
        {
          lane_id: "lane-1",
          project_name: "UI2",
          brain_url: PLANNER,
          brain_url_revision: 4,
          work_url: EXECUTOR,
          work_url_revision: 5,
          work_url_saved_at: null,
          work_mode: "OWNER",
          enabled: true
        },
        {
          lane_id: "lane-2",
          project_name: "Project 2",
          brain_url: "",
          brain_url_revision: 0,
          work_url: "",
          work_url_revision: 0,
          work_url_saved_at: null,
          work_mode: "AUTO",
          enabled: false
        },
        {
          lane_id: "lane-3",
          project_name: "Project 3",
          brain_url: "",
          brain_url_revision: 0,
          work_url: "",
          work_url_revision: 0,
          work_url_saved_at: null,
          work_mode: "AUTO",
          enabled: false
        }
      ]
    },
    registry: {
      schema_version: "three-lane-registry.v1",
      mode: "THREE_LANE_V1",
      lanes: {
        "lane-1": {
          lane_id: "lane-1",
          brain_url: PLANNER,
          applied_brain_url_revision: 4,
          work_url: EXECUTOR,
          work_generation: 2,
          applied_work_url_revision: 5,
          pending_work_url: "",
          pending_work_url_revision: 0,
          task_id: null,
          instruction_digest: null,
          last_brain_directive_digest: null,
          last_work_result_digest: null,
          last_result_relay_id: null,
          last_result_verdict: null,
          last_dispatch_id: null,
          dispatch_inflight: null,
          relay_inflight: null,
          brain_request_inflight: null,
          brain_request_sent: false,
          awaiting_work: false,
          project_progress: {
            schema_version: "project-progress.v1",
            plan_known: true,
            tasks: []
          },
          task_timing: {
            schema_version: "task-timing.v1",
            task_id: null
          }
        },
        "lane-2": {
          lane_id: "lane-2",
          brain_url: "",
          applied_brain_url_revision: 0,
          work_url: "",
          work_generation: 0,
          applied_work_url_revision: 0,
          pending_work_url: "",
          pending_work_url_revision: 0,
          task_id: null,
          dispatch_inflight: null,
          relay_inflight: null,
          brain_request_inflight: null,
          brain_request_sent: false,
          awaiting_work: false
        },
        "lane-3": {
          lane_id: "lane-3",
          brain_url: "",
          applied_brain_url_revision: 0,
          work_url: "",
          work_generation: 0,
          applied_work_url_revision: 0,
          pending_work_url: "",
          pending_work_url_revision: 0,
          task_id: null,
          dispatch_inflight: null,
          relay_inflight: null,
          brain_request_inflight: null,
          brain_request_sent: false,
          awaiting_work: false
        }
      }
    }
  };
}

async function writeLegacyRoot({
  activeTask = null,
  reviewBoundary = false,
  incompleteReviewEvidence = false
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-pe007-cutover-"));
  const fixture = legacyFixture();
  if (activeTask) {
    fixture.registry.lanes["lane-1"].task_id = activeTask;
    fixture.registry.lanes["lane-1"].awaiting_work = true;
  }
  if (reviewBoundary) {
    const lane = fixture.registry.lanes["lane-1"];
    lane.task_id = "UI2-015";
    lane.awaiting_work = false;
    lane.brain_request_sent = true;
    lane.last_dispatch_id = "legacy-A015";
    lane.last_result_relay_id = incompleteReviewEvidence ? null : "legacy-R015";
    lane.last_work_result_digest = incompleteReviewEvidence ? null : "result-digest-015";
    lane.task_timing = {
      schema_version: "task-timing.v1",
      task_id: "UI2-015"
    };
  }
  await fs.writeFile(
    path.join(root, "lanes.json"),
    JSON.stringify(fixture.config, null, 2) + "\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "lane-registry.json"),
    JSON.stringify(fixture.registry, null, 2) + "\n",
    "utf8"
  );
  return root;
}

test("PE-007 cutover candidate is ready only for an idle qualified legacy lane", async () => {
  const root = await writeLegacyRoot();
  const candidate = await preparePlannerExecutorProductionCutover({
    root,
    laneId: "lane-1",
    authorizedAt: "2026-09-27T11:55:00+07:00",
    sourceRevision: "abc123"
  });

  assert.equal(candidate.cutover_ready, true);
  assert.deepEqual(candidate.blockers, []);
  assert.equal(candidate.state.mode, "PLANNER_EXECUTOR_V1");
  assert.equal(candidate.state.project_name, "UI2");
  assert.equal(candidate.state.planner.target, PLANNER);
  assert.equal(candidate.state.executor.target, EXECUTOR);
  assert.equal(candidate.state.production_cutover.authorized, true);
  assert.equal(
    candidate.state.production_cutover.source_lane_id,
    "lane-1"
  );
  assert.equal(candidate.state.cutover_bootstrap.required, true);
  assert.ok(candidate.state.cutover_bootstrap.message_digest);
  assert.match(
    candidate.state.cutover_bootstrap.message,
    /Planner\/Executor V1/
  );
  assert.match(
    candidate.state.cutover_bootstrap.message,
    /Không dùng ChatGPT Work mode/
  );
  assert.match(
    candidate.state.cutover_bootstrap.message,
    /<AT>M \{"v":1,"a":"assign"/
  );
  assert.doesNotMatch(
    candidate.state.cutover_bootstrap.message,
    /@M \{"v":1/
  );
  assert.match(
    candidate.state.cutover_bootstrap.message,
    /U\+0040/
  );
});

test("PE-007 cutover preserves PE-005 fail-closed blockers for an active legacy task", async () => {
  const root = await writeLegacyRoot({ activeTask: "UI2-015" });
  const candidate = await preparePlannerExecutorProductionCutover({
    root,
    laneId: "lane-1",
    authorizedAt: "2026-09-27T11:55:00+07:00",
    sourceRevision: "abc123"
  });

  assert.equal(candidate.cutover_ready, false);
  assert.ok(candidate.blockers.includes("ACTIVE_LEGACY_TASK"));
  assert.ok(candidate.blockers.includes("LEGACY_AWAITING_EXECUTOR"));
});

test("PE-007 adopts only the exact legacy result-review boundary without replaying Executor work", async () => {
  const root = await writeLegacyRoot({ reviewBoundary: true });
  const candidate = await preparePlannerExecutorProductionCutover({
    root,
    laneId: "lane-1",
    authorizedAt: "2026-09-27T11:55:00+07:00",
    sourceRevision: "abc123"
  });

  assert.equal(candidate.cutover_ready, true);
  assert.deepEqual(candidate.blockers, []);
  assert.deepEqual(candidate.resolved_blockers.sort(), [
    "ACTIVE_LEGACY_TASK",
    "LEGACY_PLANNER_REQUEST_SENT_UNCONSUMED"
  ].sort());
  assert.equal(candidate.handoff_mode, "LEGACY_RESULT_REVIEW");
  assert.equal(candidate.state.active_task_id, "UI2-015");
  assert.equal(candidate.state.assignment.task_id, "UI2-015");
  assert.equal(candidate.state.assignment.assignment_id, "legacy-A015");
  assert.ok(candidate.state.assignment.send_confirmed_at);
  assert.equal(candidate.state.result.task_id, "UI2-015");
  assert.equal(candidate.state.result.assignment_id, "legacy-A015");
  assert.equal(candidate.state.result.result_id, "legacy-R015");
  assert.ok(candidate.state.result.relay_confirmed_at);
  assert.equal(
    candidate.state.production_cutover.handoff_mode,
    "LEGACY_RESULT_REVIEW"
  );
  assert.match(
    candidate.state.cutover_bootstrap.message,
    /PRODUCTION REVIEW HANDOFF/
  );
  assert.match(
    candidate.state.cutover_bootstrap.message,
    /"a":"accept_assign".*"t":"UI2-015".*"r":"legacy-R015"/
  );
  assert.match(
    candidate.state.cutover_bootstrap.message,
    /"a":"reject".*"t":"UI2-015".*"r":"legacy-R015"/
  );
  assert.match(
    candidate.state.cutover_bootstrap.message,
    /Không gửi lại result, không giao lại task cũ/
  );
});

test("PE-007 keeps the result-review boundary blocked when exact relay evidence is incomplete", async () => {
  const root = await writeLegacyRoot({
    reviewBoundary: true,
    incompleteReviewEvidence: true
  });
  const candidate = await preparePlannerExecutorProductionCutover({
    root,
    laneId: "lane-1",
    authorizedAt: "2026-09-27T11:55:00+07:00",
    sourceRevision: "abc123"
  });

  assert.equal(candidate.cutover_ready, false);
  assert.ok(candidate.blockers.includes("ACTIVE_LEGACY_TASK"));
  assert.ok(
    candidate.blockers.includes("LEGACY_PLANNER_REQUEST_SENT_UNCONSUMED")
  );
  assert.equal(candidate.handoff_mode, "IDLE");
  assert.equal(candidate.state.assignment, null);
  assert.equal(candidate.state.result, null);
});

test("production bootstrap is compact, role-specific, and never invokes Work mode", () => {
  const message = buildProductionPlannerBootstrap({
    projectName: "UI2",
    sourceLaneId: "lane-1"
  });
  assert.match(message, /Bạn là Planner/);
  assert.match(message, /giao đúng MỘT task/);
  assert.match(message, /Không dùng ChatGPT Work mode/);
  assert.doesNotMatch(message, /MAGASIN_WORK_DISPATCH_V1/);
});

test("Planner bootstrap runs only after execute-mode dry-run exit", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/planner-executor-cli.mjs", import.meta.url),
    "utf8"
  );
  const dryRunIndex = source.indexOf("if (!args.execute)");
  const bootstrapIndex = source.indexOf("run: () => ensureProductionPlannerBootstrap({");
  assert.ok(dryRunIndex >= 0);
  assert.ok(bootstrapIndex > dryRunIndex);
  assert.match(source.slice(dryRunIndex, bootstrapIndex), /process\.exit\(0\)/);
});

test("historical bootstrap ownership is render-equivalent but guarded clear uses the exact live composer digest", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/planner-executor-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /function normalizeBootstrapOwnershipText/);
  assert.match(source, /\.replace\(\/\\s\+\/gu, " "\)/);
  assert.match(source, /normalizeBootstrapOwnershipText\(candidate\) === observedOwnershipText/);
  assert.match(source, /digest: observedDigest/);
  assert.doesNotMatch(source, /digest: candidateDigest/);
});

test("project bootstrap safely migrates canonical Robot drafts from current or prior generations", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/planner-executor-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /discardComposerDraftIfDigest/);
  assert.match(source, /buildLegacyProjectContextBootstrapMessage/);
  assert.match(source, /buildPreLinkOnlyMentionSafeProjectContextBootstrapMessage/);
  assert.match(source, /matchCanonicalHistoricalProjectBootstrapDraft/);
  assert.doesNotMatch(source, /generation > currentGeneration/);
  assert.match(source, /project_id: projectId/);
  assert.match(source, /project_generation: generation/);
  assert.match(source, /sourceUrl !== currentSourceUrl/);
  assert.match(source, /buildProjectContextBootstrapMessage\(historicalState\)/);
  assert.match(source, /migrated-canonical-bootstrap-draft-generation-/);
  assert.match(source, /bootstrap\.send_attempted_at = null/);
  assert.match(source, /draft\.has_text = false/);
  assert.match(source, /draft\.normalized_text = null/);
  assert.match(source, /project bootstrap blocked by foreign or Owner draft/);
});

test("bootstrap recovery reacquires Planner/Executor pages when ChatGPT closes or replaces a target page", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/planner-executor-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /recoverTarget = null/);
  assert.match(source, /PLANNER_EXECUTOR_\$\{name\}_TARGET_REACQUIRED/);
  assert.match(source, /const reacquireWarmTabs = async \(\) =>/);
  assert.match(source, /acquirePlannerExecutorWarmTabs\(adapter/);
  assert.match(source, /assertPlannerExecutorWarmTabs\(adapter, warm\)/);
  assert.match(source, /recoverTarget: reacquireWarmTabs/);
});

test("bootstrap recovery survives ChatGPT rerender when baseline user turn proves no submission occurred", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/planner-executor-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /bootstrapHasProvableNoNewUserTurn/);
  assert.match(source, /rearmed-after-page-rerender-with-baseline-user-turn-unchanged/);
  assert.match(source, /bootstrap\.send_attempted_at = null/);
  assert.match(source, /bootstrap\.retry_count = Number\(bootstrap\.retry_count \|\| 0\) \+ 1/);
  assert.match(source, /runBootstrapStageWithRecovery/);
  assert.match(source, /PROJECT_CONTEXT_BOOTSTRAP_RETRY/);
  assert.match(source, /CUTOVER_BOOTSTRAP_RETRY/);
  assert.match(source, /bootstrap_retry_attempt/);
  assert.match(source, /isRecoverableBootstrapError/);
});

test("all Robot-authored Planner/Executor prompts transport machine-frame examples without literal @M", async () => {
  const cli = await fs.readFile(
    new URL("../src/runtime/planner-executor-cli.mjs", import.meta.url),
    "utf8"
  );
  const runtime = await fs.readFile(
    new URL("../src/runtime/planner-executor.mjs", import.meta.url),
    "utf8"
  );

  const projectBootstrapStart = cli.indexOf("function buildProjectContextBootstrapMessage");
  const projectBootstrapEnd = cli.indexOf("async function ensureProjectContextBootstrap", projectBootstrapStart);
  const projectBootstrap = cli.slice(projectBootstrapStart, projectBootstrapEnd);
  assert.match(projectBootstrap, /<AT>M/);
  assert.match(projectBootstrap, /U\+0040/);
  assert.doesNotMatch(projectBootstrap, /@M \{"v":1/);

  const messageBuildersStart = runtime.indexOf("function machineFrameTransportInstruction");
  const messageBuildersEnd = runtime.indexOf("function buildExecutorRolloverMessage", messageBuildersStart);
  const messageBuilders = runtime.slice(messageBuildersStart, messageBuildersEnd);
  assert.match(messageBuilders, /<AT>M/);
  assert.match(messageBuilders, /U\+0040/);
  assert.doesNotMatch(messageBuilders, /@M \{"v":1/);
});

test("production wrapper routes single-conversation control before legacy adapter and keeps Planner Executor inert", async () => {
  const source = await fs.readFile(
    new URL("../windows/run-supervisor.ps1", import.meta.url),
    "utf8"
  );
  assert.match(source, /single-conversation-control\.json/);
  assert.match(source, /SINGLE_CONVERSATION_V1/);
  assert.match(source, /single-conversation-cli\.mjs/);
  assert.match(source, /--source-of-truth/);
  assert.match(source, /planner-executor-state\.json/);
  assert.match(source, /PLANNER_EXECUTOR_V1/);
  assert.match(source, /planner-executor-cli\.mjs/);
  assert.doesNotMatch(source, /return 'PLANNER_EXECUTOR_V1'/);
  assert.match(source, /LEGACY_PLANNER_EXECUTOR_SELECTION_IGNORED=True/);
  assert.match(source, /runtimeMode -ne 'SINGLE_CONVERSATION_V1'/);
});

test("lifecycle truth recognizes Planner/Executor as the active production runtime", async () => {
  const source = await fs.readFile(
    new URL("../windows/lifecycle-truth.ps1", import.meta.url),
    "utf8"
  );
  assert.match(source, /Get-LifecyclePlannerExecutorProcess/);
  assert.match(source, /planner_executor_alive/);
  assert.match(source, /runtime_mode/);
  assert.match(source, /PLANNER_EXECUTOR_V1/);
});

test("cutover candidate CLI stdout is excluded from the PowerShell function return pipeline", async () => {
  const source = await fs.readFile(
    new URL(
      "../.github/scripts/supervisor-pe007-production-cutover.ps1",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(source, /& node @candidateArgs \| Out-Host/);
  assert.match(
    source,
    /return Get-Content \$candidatePath -Raw -Encoding UTF8 \| ConvertFrom-Json/
  );
});

test("Planner/Executor startup failures persist privacy-safe stage and digest only", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/planner-executor-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /planner-executor-startup-failure\.json/);
  assert.match(source, /startupStage = "ACQUIRE_WARM_TABS"/);
  assert.match(source, /startupStage = "CUTOVER_BOOTSTRAP"/);
  assert.match(source, /startupStage = "RUN_LOOP"/);

  const start = source.indexOf("const safeFailure = {");
  const end = source.indexOf("await atomicJsonWrite(startupFailurePath", start);
  assert.ok(start >= 0 && end > start);
  const artifactBlock = source.slice(start, end);
  assert.match(artifactBlock, /error_digest/);
  assert.match(artifactBlock, /bootstrap_send_confirmed/);
  assert.match(artifactBlock, /observed_chatgpt_tabs/);
  assert.doesNotMatch(artifactBlock, /error_message\s*:/);
  assert.doesNotMatch(artifactBlock, /planner\.target/);
  assert.doesNotMatch(artifactBlock, /executor\.target/);
  assert.doesNotMatch(artifactBlock, /bootstrap\.message/);
});

test("cutover timeout emits privacy-safe runtime/startup diagnostics before rollback", async () => {
  const source = await fs.readFile(
    new URL(
      "../.github/scripts/supervisor-pe007-production-cutover.ps1",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(source, /function Write-PrivacySafeCutoverDiagnostics/);
  assert.match(source, /PE007_DIAG_RUNTIME_MODE/);
  assert.match(source, /PE007_DIAG_PLANNER_EXECUTOR_ALIVE/);
  assert.match(source, /PE007_DIAG_FAILURE_STAGE/);
  assert.match(source, /PE007_DIAG_FAILURE_DIGEST/);
  assert.match(source, /PE007_DIAG_BOOTSTRAP_SEND_CONFIRMED/);
  assert.match(
    source,
    /if \(-not \$healthy\) \{\s*Write-PrivacySafeCutoverDiagnostics/
  );
  const diagStart = source.indexOf("function Write-PrivacySafeCutoverDiagnostics");
  const diagEnd = source.indexOf("function New-RollbackSnapshot", diagStart);
  const diagBlock = source.slice(diagStart, diagEnd);
  assert.doesNotMatch(diagBlock, /\.planner\.target/);
  assert.doesNotMatch(diagBlock, /\.executor\.target/);
  assert.doesNotMatch(diagBlock, /cutover_bootstrap\.message/);
});

test("production cutover script has rollback, double preflight, and explicit target authority", async () => {
  const source = await fs.readFile(
    new URL(
      "../.github/scripts/supervisor-pe007-production-cutover.ps1",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(source, /DESKTOP-4K7IM13/);
  assert.match(source, /owner_cutover_authorization/);
  assert.match(source, /Write-Candidate/);
  assert.match(source, /Stop-SupervisorTechnical/);
  assert.match(source, /New-RollbackSnapshot/);
  assert.match(source, /Restore-RollbackSnapshot/);
  assert.match(source, /PE007_PRODUCTION_CUTOVER=PASS/);
  assert.match(source, /planner-executor-status\.json/);
  assert.match(source, /chatgpt_work_mode_invocations/);
});


test("production CLI publishes ChatGPT tab heartbeat before each bootstrap send stage", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/planner-executor-cli.mjs", import.meta.url),
    "utf8"
  );

  const first = source.indexOf('phase: "CUTOVER_BOOTSTRAP"');
  const second = source.indexOf('phase: "PROJECT_CONTEXT_BOOTSTRAP"');
  const confirmed = source.indexOf('phase: "BOOTSTRAP_CONFIRMED"');
  assert.ok(first >= 0);
  assert.ok(second > first);
  assert.ok(confirmed > second);
  assert.match(source.slice(first, confirmed), /chatgpt_tabs:\s*adapter\.getChatGptPageCount\(\)/);
});

test("production CLI persists cutover-ready status immediately after bootstrap confirmation", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/planner-executor-cli.mjs", import.meta.url),
    "utf8"
  );

  const bootstrapIndex = source.indexOf("run: () => ensureProductionPlannerBootstrap({");
  const readyIndex = source.indexOf('phase: "BOOTSTRAP_CONFIRMED"');
  const runLoopIndex = source.indexOf('startupStage = "RUN_LOOP"');

  assert.ok(bootstrapIndex >= 0);
  assert.ok(readyIndex > bootstrapIndex);
  assert.ok(runLoopIndex > readyIndex);
  assert.match(
    source.slice(readyIndex, runLoopIndex),
    /production_cutover:\s*true/
  );
  assert.match(
    source.slice(readyIndex, runLoopIndex),
    /chatgpt_tabs:\s*adapter\.getChatGptPageCount\(\)/
  );
  assert.match(
    source.slice(readyIndex, runLoopIndex),
    /chatgpt_work_mode_invocations:\s*0/
  );
});


test("production CLI bootstraps Planner from per-project Source of Truth before run loop", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/planner-executor-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /MAGASIN_PROJECT_BOOTSTRAP_V1/);
  assert.match(source, /source_of_truth=/);
  assert.match(source, /Đọc lại dự án từ Source of Truth/);
  assert.match(source, /"pc":COMPLETED,"pt":TOTAL/);
  assert.match(source, /ensureProjectContextBootstrap/);
  const bootstrapCall = source.indexOf("run: () => ensureProjectContextBootstrap({");
  const runLoop = source.indexOf('startupStage = "RUN_LOOP"');
  assert.ok(bootstrapCall >= 0);
  assert.ok(runLoop > bootstrapCall);
});
