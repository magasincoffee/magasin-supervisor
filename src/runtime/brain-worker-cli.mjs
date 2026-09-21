import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import {
  ChatGptUiAdapter,
  isTransientNavigationError
} from "../ui/playwright-adapter.mjs";
import { sendComposerInstruction } from "../ui/actions.mjs";
import {
  captureAssistantTurnDigests,
  captureCompletedAssistantTurn,
  captureRecentAssistantTurns,
  captureRecentConversationTurns,
  captureUserTurnDigests
} from "../ui/message-capture.mjs";
import { OBSERVATIONS } from "../decision.mjs";
import { readProjectStateFromAdapter } from "../project-adapter.mjs";
import { resolveSupervisorStateRoot } from "./state-root.mjs";
import { pageMatchesTarget, targetFromUrl } from "./recovery.mjs";
import {
  BRAIN_WORKER_MODE,
  assertRolloverAuthorized,
  buildBrainBootstrapInstruction,
  buildBrainRolloverInstruction,
  buildWorkerResultEnvelope,
  canCreateWorker,
  newRegistry,
  parseBrainDirective,
  sanitizeRegistry
} from "./orchestration.mjs";
import {
  buildRuntimeStatus,
  defaultRuntimeStatusPath
} from "./status.mjs";

const SUPERVISOR_RUNTIME_VERSION = "2026-09-19.29";

function parseArgs(argv) {
  const result = {
    cdpUrl: "http://127.0.0.1:9222",
    execute: false,
    pollMs: 5000
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--cdp-url") result.cdpUrl = argv[++i];
    else if (key === "--project-adapter") result.projectAdapter = argv[++i];
    else if (key === "--execute") result.execute = true;
    else if (key === "--poll-ms") result.pollMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${key}`);
  }
  return result;
}

function localRoot() {
  return resolveSupervisorStateRoot(process.env);
}

class ProjectAdapterFetchError extends Error {
  constructor(message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "ProjectAdapterFetchError";
  }
}

async function readProjectState(source) {
  try {
    return await readProjectStateFromAdapter(source);
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) throw error;
    throw new ProjectAdapterFetchError(
      `project adapter temporarily unavailable: ${String(error?.message || error)}`,
      error
    );
  }
}

async function atomicJsonWrite(filePath, value) {
  const temp = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(temp, filePath);
}

async function loadRegistry(filePath) {
  try {
    return sanitizeRegistry(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return newRegistry();
  }
}

async function safeLog(filePath, event = {}) {
  const safe = {
    timestamp: new Date().toISOString(),
    type: String(event.type || "EVENT"),
    role: event.role || undefined,
    worker_id: event.workerId || undefined,
    task_id: event.taskId || undefined,
    relay_id: event.relayId || undefined,
    digest: event.digest || undefined,
    chars: Number.isFinite(event.chars) ? event.chars : undefined,
    generation: Number.isFinite(event.generation) ? event.generation : undefined,
    reason: event.reason || undefined,
    error_name: event.errorName || undefined
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(safe) + "\n", "utf8");
}

async function writeStatus(filePath, projectState, {
  status,
  brainStatus = null,
  workers = {},
  errorName = null,
  reason = null
}) {
  const base = buildRuntimeStatus({
    projectState,
    status,
    decision: reason ? { action: "WAIT", reason } : null,
    errorName
  });
  const workerList = Object.values(workers || {});
  const payload = {
    ...base,
    schema_version: 3,
    supervisor_runtime_version: SUPERVISOR_RUNTIME_VERSION,
    orchestration_mode: BRAIN_WORKER_MODE,
    brain_status: brainStatus,
    worker_count: workerList.length,
    worker_running: new Set(["RUNNING", "READY"]).has(status)
      ? workerList
        .filter((worker) => worker.awaiting_result && worker.status === "RUNNING")
        .map((worker) => worker.worker_id)
      : []
  };
  await atomicJsonWrite(filePath, payload);
}

function targetUrl(target) {
  return `${target.origin}${target.pathname}`;
}

function uniqueCandidatesByTarget(candidates = []) {
  const unique = new Map();
  for (const candidate of candidates) {
    if (!candidate?.target) continue;
    const key = targetUrl(candidate.target);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()];
}


function candidateRegistryScore(candidate, registry) {
  const actions = candidate?.valid?.directive?.actions || [];
  let score = 0;
  for (const action of actions) {
    if (action?.type !== "DISPATCH") continue;
    const worker = registry?.workers?.[action.worker_id];
    if (!worker) continue;
    if (worker.task_id === action.task_id) {
      score += worker.awaiting_result ? 10 : 6;
    }
    if (
      worker.instruction_digest &&
      action.instruction_digest &&
      worker.instruction_digest === action.instruction_digest
    ) {
      score += 4;
    }
  }
  return score;
}

async function resolveBrainCandidate(adapter, candidates, registry, multipleError) {
  const uniqueCandidates = uniqueCandidatesByTarget(candidates);
  if (uniqueCandidates.length <= 1) return uniqueCandidates[0] || null;

  const scored = uniqueCandidates
    .map((candidate) => ({
      candidate,
      score: candidateRegistryScore(candidate, registry)
    }))
    .sort((left, right) => right.score - left.score);

  if (
    scored[0]?.score > 0 &&
    scored[0].score > Number(scored[1]?.score || 0)
  ) {
    return scored[0].candidate;
  }

  const focusedPages = await adapter.getFocusedChatGptPages().catch(() => []);
  const focusedTargets = new Set();
  for (const page of focusedPages) {
    try {
      focusedTargets.add(targetUrl(targetFromUrl(page.url())));
    } catch {
      // Non-conversation pages are not Brain candidates.
    }
  }
  const focusedCandidates = uniqueCandidates.filter(
    (candidate) => focusedTargets.has(targetUrl(candidate.target))
  );
  if (focusedCandidates.length === 1) return focusedCandidates[0];

  throw new Error(multipleError);
}

function hardStopObservation(observation) {
  return new Set([
    OBSERVATIONS.AUTH_REQUIRED,
    OBSERVATIONS.MFA_REQUIRED,
    OBSERVATIONS.CAPTCHA,
    OBSERVATIONS.DESTRUCTIVE_ACTION,
    OBSERVATIONS.ADMIN_ESCALATION,
    OBSERVATIONS.AMBIGUOUS_DECISION
  ]).has(observation);
}

async function waitForTarget(page) {
  await page.waitForURL((value) => {
    try {
      targetFromUrl(value);
      return true;
    } catch {
      return false;
    }
  }, { timeout: 45_000 });
  return targetFromUrl(page.url());
}

async function openTargetPage(adapter, target) {
  const existing = adapter.findPageForTarget(target);
  if (existing) return existing;

  const page = await adapter.reopenTargetPage(targetUrl(target));
  try {
    await page.waitForURL(
      (value) => pageMatchesTarget(String(value), target),
      { timeout: 10_000 }
    );
  } catch {
    if (!pageMatchesTarget(page.url(), target)) {
      throw new Error("registered ChatGPT target could not be restored; target mismatch; new conversation denied");
    }
  }
  return page;
}

async function createConversationWithMessage(adapter, message, { execute }) {
  const page = await adapter.newChatPage("https://chatgpt.com/");
  await page.waitForTimeout(1000);
  const execution = await sendComposerInstruction(page, message, { dryRun: !execute });
  if (!execute) return { page, target: null, execution };
  if (!execution.executed) {
    throw new Error(`new conversation send failed: ${execution.reason || "unknown"}`);
  }
  const target = await waitForTarget(page);
  return { page, target, execution };
}

async function captureLatestValidBrainDirective(page, config) {
  const turns = await captureRecentConversationTurns(page, { limit: 40 });
  let latestUserIndex = -1;
  for (let index = 0; index < turns.length; index += 1) {
    if (turns[index].role === "user") latestUserIndex = index;
  }

  for (let index = turns.length - 1; index > latestUserIndex; index -= 1) {
    const captured = turns[index];
    if (captured.role !== "assistant") continue;
    try {
      const directive = parseBrainDirective(captured.text, {
        maxWorkers: workerCapacity(config)
      });
      return { captured, directive };
    } catch {
      // Progress/status assistant turns are not Brain directives.
    }
  }
  return null;
}

async function findBrainByContinuity(adapter, registry) {
  const expectedDigest = registry?.brain?.last_processed_digest || null;
  if (!expectedDigest) return null;

  const candidates = [];
  for (const page of adapter.getChatGptPages()) {
    let target = null;
    try {
      target = targetFromUrl(page.url());
    } catch {
      continue;
    }

    const digests = await captureAssistantTurnDigests(page).catch(() => []);
    if (digests.includes(expectedDigest)) {
      candidates.push({ page, target, method: "CONTINUITY" });
    }
  }

  return resolveBrainCandidate(
    adapter,
    candidates,
    registry,
    "multiple distinct ChatGPT conversations match Brain continuity; automatic target rebind denied"
  );
}

async function findBrainByDirectiveSignature(adapter, config, registry) {
  const candidates = [];

  for (const page of adapter.getChatGptPages()) {
    let target = null;
    try {
      target = targetFromUrl(page.url());
    } catch {
      continue;
    }

    const probe = await adapter.probePage(page).catch(() => null);
    if (!probe || probe.classification.observation !== OBSERVATIONS.RESPONSE_COMPLETE) {
      continue;
    }
    if (hardStopObservation(probe.classification.observation)) {
      continue;
    }

    const valid = await captureLatestValidBrainDirective(page, config).catch(() => null);
    if (valid) {
      candidates.push({ page, target, method: "DIRECTIVE_SIGNATURE", valid });
    }
  }

  return resolveBrainCandidate(
    adapter,
    candidates,
    registry,
    "multiple distinct open ChatGPT conversations have a valid Brain directive signature; automatic target rebind denied"
  );
}

async function applyOwnerBrainRebind({
  adapter,
  registry,
  config,
  execute,
  requestPath,
  registryPath,
  logPath
}) {
  const requested = await fs.access(requestPath).then(() => true).catch(() => false);
  if (!requested) return null;

  const visiblePages = await adapter.getVisibleChatGptPages();
  const candidates = [];

  for (const page of visiblePages) {
    let target = null;
    try {
      target = targetFromUrl(page.url());
    } catch {
      continue;
    }

    const probe = await adapter.probePage(page).catch(() => null);
    if (!probe || hardStopObservation(probe.classification.observation)) continue;
    if (probe.snapshot.conversationMissing || probe.snapshot.conversationFull) continue;

    const valid = await captureLatestValidBrainDirective(page, config).catch(() => null);
    if (valid) candidates.push({ page, target, valid });
  }

  await fs.unlink(requestPath).catch(() => {});

  const selected = await resolveBrainCandidate(
    adapter,
    candidates,
    registry,
    "more than one distinct visible ChatGPT conversation looks like Brain; owner rebind denied"
  );
  if (!selected) {
    throw new Error(
      "open the intended Brain conversation in Robot Chrome, keep that tab visible, then press the Brain rebind button again"
    );
  }

  if (!execute) return selected.page;

  registry.brain.target = selected.target;
  registry.brain.awaiting_response = true;
  await atomicJsonWrite(registryPath, sanitizeRegistry(registry));
  await safeLog(logPath, {
    type: "BRAIN_TARGET_REBOUND_OWNER",
    role: "brain",
    generation: registry.brain.generation
  });
  return selected.page;
}

async function findBrainFromRecentSidebar(adapter, config) {
  const pages = adapter.getChatGptPages();
  if (!pages.length) return null;

  const discoveryPage = pages.find((page) => {
    try {
      return new URL(page.url()).pathname === "/";
    } catch {
      return false;
    }
  }) || pages[0];

  const recentUrls = await adapter.listRecentConversationUrls(discoveryPage, { limit: 20 });
  if (!recentUrls.length) return null;

  const scout = discoveryPage;
  const candidateTargets = new Map();

  for (const url of recentUrls) {
    let target = null;
    try {
      target = targetFromUrl(url);
    } catch {
      continue;
    }

    const existing = adapter.findPageForTarget(target);
    const page = existing || scout;

    if (!existing) {
      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 15_000
        });
        await page.waitForTimeout(1200);
      } catch {
        continue;
      }
    }

    const probe = await adapter.probePage(page).catch(() => null);
    if (!probe || probe.classification.observation !== OBSERVATIONS.RESPONSE_COMPLETE) {
      continue;
    }

    const valid = await captureLatestValidBrainDirective(page, config).catch(() => null);
    if (valid) {
      candidateTargets.set(targetUrl(target), target);
    }
  }

  if (candidateTargets.size > 1) {
    throw new Error("multiple distinct recent ChatGPT conversations have a valid Brain directive signature; automatic target rebind denied");
  }
  if (candidateTargets.size !== 1) return null;
  const target = [...candidateTargets.values()][0];
  const existing = adapter.findPageForTarget(target);
  if (existing) return { page: existing, target, method: "SIDEBAR_SIGNATURE" };

  await scout.goto(targetUrl(target), {
    waitUntil: "domcontentloaded",
    timeout: 15_000
  });
  await scout.waitForTimeout(1200);
  return { page: scout, target, method: "SIDEBAR_SIGNATURE" };
}

async function ensureBrain({ adapter, registry, projectState, config, execute, registryPath, logPath }) {
  if (registry.brain.target) {
    try {
      return await openTargetPage(adapter, registry.brain.target);
    } catch (error) {
      const message = String(error?.message || error);
      if (!/target mismatch/.test(message)) throw error;

      const recovered =
        await findBrainByContinuity(adapter, registry) ||
        await findBrainByDirectiveSignature(adapter, config, registry) ||
        await findBrainFromRecentSidebar(adapter, config);
      if (!recovered) throw error;
      if (!execute) return recovered.page;

      registry.brain.target = recovered.target;
      await atomicJsonWrite(registryPath, sanitizeRegistry(registry));
      await safeLog(logPath, {
        type: recovered.method === "CONTINUITY"
          ? "BRAIN_TARGET_REBOUND_CONTINUITY"
          : recovered.method === "SIDEBAR_SIGNATURE"
            ? "BRAIN_TARGET_REBOUND_SIDEBAR"
            : "BRAIN_TARGET_REBOUND_SIGNATURE",
        role: "brain",
        generation: registry.brain.generation
      });
      return recovered.page;
    }
  }
  if (!execute) return null;
  if (!config?.brain?.bootstrap_authorized) {
    throw new Error("brain bootstrap is not authorized by source of truth");
  }
  if (registry.brain.bootstrap_consumed || registry.brain.creation_latch) {
    throw new Error("Brain bootstrap outcome is uncertain; automatic second Brain creation is denied");
  }

  registry.brain.bootstrap_consumed = true;
  registry.brain.creation_latch = {
    kind: "OWNER_AUTHORIZED_INITIAL_BRAIN",
    generation: 1
  };
  await atomicJsonWrite(registryPath, sanitizeRegistry(registry));

  const created = await createConversationWithMessage(
    adapter,
    buildBrainBootstrapInstruction(projectState),
    { execute: true }
  );

  registry.brain.target = created.target;
  registry.brain.generation = 1;
  registry.brain.awaiting_response = true;
  registry.brain.creation_latch = null;
  await atomicJsonWrite(registryPath, sanitizeRegistry(registry));
  await safeLog(logPath, {
    type: "BRAIN_BOOTSTRAPPED",
    role: "brain",
    generation: 1
  });
  return created.page;
}

async function rolloverBrain({ adapter, registry, projectState, execute, registryPath, logPath, snapshot }) {
  assertRolloverAuthorized(snapshot);
  if (!execute) return null;
  if (registry.brain.creation_latch) {
    throw new Error("Brain rollover outcome is uncertain; duplicate conversation creation is denied");
  }

  const nextGeneration = registry.brain.generation + 1;
  registry.brain.creation_latch = {
    kind: "ROLLOVER_FULL_CONFIRMED",
    generation: nextGeneration
  };
  await atomicJsonWrite(registryPath, sanitizeRegistry(registry));

  const created = await createConversationWithMessage(
    adapter,
    buildBrainRolloverInstruction(projectState, registry),
    { execute: true }
  );

  registry.brain.target = created.target;
  registry.brain.generation = nextGeneration;
  registry.brain.awaiting_response = true;
  registry.brain.last_processed_digest = null;
  registry.brain.creation_latch = null;
  await atomicJsonWrite(registryPath, sanitizeRegistry(registry));
  await safeLog(logPath, {
    type: "BRAIN_ROLLOVER_FULL_CONFIRMED",
    role: "brain",
    generation: registry.brain.generation
  });
  return created.page;
}

function workerCapacity(config) {
  const value = Number(config?.workers?.max_parallel_workers || 3);
  if (!Number.isInteger(value) || value < 1 || value > 12) {
    throw new Error("invalid max_parallel_workers");
  }
  return value;
}

async function reconcileUncertainWorkerDispatch({
  adapter,
  registry,
  worker,
  action,
  registryPath,
  logPath
}) {
  const latch = worker.dispatch_latch || worker.creation_latch || null;
  if (!latch) return false;

  if (
    latch.task_id && latch.task_id !== action.task_id ||
    latch.instruction_digest && latch.instruction_digest !== action.instruction_digest
  ) {
    throw new Error(`worker ${worker.worker_id} has a conflicting uncertain prior send outcome; automatic retry is denied`);
  }

  const candidates = [];
  for (const page of adapter.getChatGptPages()) {
    let target = null;
    try {
      target = targetFromUrl(page.url());
    } catch {
      continue;
    }

    const instructionDigests = await captureUserTurnDigests(page).catch(() => []);
    if (!instructionDigests.includes(action.instruction_digest)) continue;

    const probe = await adapter.probePage(page).catch(() => null);
    if (!probe || hardStopObservation(probe.classification.observation)) continue;
    if (probe.snapshot.conversationMissing || probe.snapshot.conversationFull) continue;

    const latestAssistant = await captureCompletedAssistantTurn(page).catch(() => null);
    if (
      latestAssistant?.digest &&
      worker.last_result_digest &&
      latestAssistant.digest === worker.last_result_digest
    ) {
      continue;
    }

    candidates.push({ page, target });
  }

  if (candidates.length > 1) {
    throw new Error(`worker ${worker.worker_id} has multiple chats matching the uncertain instruction; automatic retry is denied`);
  }
  if (candidates.length !== 1) return false;

  const generation = Number(
    worker.dispatch_latch?.generation ||
    worker.creation_latch?.generation ||
    worker.generation ||
    0
  );

  worker.target = candidates[0].target;
  worker.generation = Math.max(Number(worker.generation || 0), generation);
  worker.task_id = action.task_id;
  worker.instruction_digest = action.instruction_digest;
  worker.status = "RUNNING";
  worker.awaiting_result = true;
  worker.creation_latch = null;
  worker.dispatch_latch = null;
  registry.workers[worker.worker_id] = worker;
  await atomicJsonWrite(registryPath, sanitizeRegistry(registry));
  await safeLog(logPath, {
    type: "WORKER_DISPATCH_RECONCILED",
    role: "worker",
    workerId: worker.worker_id,
    taskId: worker.task_id,
    digest: worker.instruction_digest,
    generation: worker.generation,
    reason: "existing ChatGPT user-turn digest proves the uncertain Worker instruction was already sent"
  });
  return true;
}

async function applyOwnerWorkerRetry({
  registry,
  requestPath,
  registryPath,
  logPath
}) {
  const requested = await fs.access(requestPath).then(() => true).catch(() => false);
  if (!requested) return false;

  const uncertain = Object.values(registry.workers || {}).filter(
    (worker) => worker.creation_latch || worker.dispatch_latch
  );
  await fs.unlink(requestPath).catch(() => {});

  if (uncertain.length !== 1) {
    throw new Error(
      uncertain.length > 1
        ? "more than one Worker has an uncertain prior send outcome; Owner retry denied"
        : "no Worker has an uncertain prior send outcome"
    );
  }

  const worker = uncertain[0];
  const digest =
    worker.dispatch_latch?.instruction_digest ||
    worker.creation_latch?.instruction_digest ||
    worker.instruction_digest ||
    null;

  if (!digest) {
    throw new Error(`worker ${worker.worker_id} uncertain retry is missing an instruction digest`);
  }
  if (worker.owner_retry_instruction_digest === digest) {
    throw new Error(`worker ${worker.worker_id} Owner retry was already used for this instruction`);
  }

  worker.owner_retry_instruction_digest = digest;
  worker.creation_latch = null;
  worker.dispatch_latch = null;
  worker.awaiting_result = false;
  worker.status = "IDLE";
  registry.workers[worker.worker_id] = worker;
  await atomicJsonWrite(registryPath, sanitizeRegistry(registry));
  await safeLog(logPath, {
    type: "WORKER_OWNER_RETRY_ARMED",
    role: "worker",
    workerId: worker.worker_id,
    taskId: worker.task_id,
    digest,
    generation: worker.generation,
    reason: "Owner explicitly authorized one bounded retry after an uncertain prior Worker send outcome"
  });
  return true;
}

async function dispatchWorker({
  adapter,
  registry,
  action,
  projectState,
  config,
  execute,
  registryPath,
  logPath
}) {
  const maxWorkers = workerCapacity(config);
  if (!canCreateWorker({
    registry,
    workerId: action.worker_id,
    maxWorkers,
    brainDirectiveValidated: true
  })) {
    throw new Error("worker capacity exceeded");
  }

  let worker = registry.workers[action.worker_id] || {
    worker_id: action.worker_id,
    target: null,
    generation: 0,
    task_id: null,
    status: "IDLE",
    awaiting_result: false,
    instruction_digest: null,
    last_result_relay_id: null,
    last_result_digest: null,
    relay_inflight_id: null,
    creation_latch: null,
    dispatch_latch: null,
    owner_retry_instruction_digest: null
  };

  if (worker.creation_latch || worker.dispatch_latch) {
    const reconciled = await reconcileUncertainWorkerDispatch({
      adapter,
      registry,
      worker,
      action,
      registryPath,
      logPath
    });
    if (reconciled) return;
    throw new Error(`worker ${worker.worker_id} has an uncertain prior create/send outcome; automatic retry is denied`);
  }
  if (
    worker.awaiting_result &&
    worker.task_id === action.task_id &&
    worker.instruction_digest === action.instruction_digest
  ) {
    return;
  }
  if (worker.awaiting_result) {
    throw new Error(`worker ${worker.worker_id} is busy`);
  }
  if (!execute) return;

  let page = null;
  let isNewConversation = false;
  let creationReason = null;

  if (worker.target) {
    page = await openTargetPage(adapter, worker.target);
    const probe = await adapter.probePage(page);
    if (hardStopObservation(probe.classification.observation)) {
      throw new Error(`worker ${worker.worker_id} reached owner/security boundary`);
    }
    if (probe.snapshot.conversationMissing) {
      throw new Error(`worker ${worker.worker_id} conversation is missing; rollover denied`);
    }
    if (probe.snapshot.conversationFull) {
      assertRolloverAuthorized(probe.snapshot);
      creationReason = "ROLLOVER_FULL_CONFIRMED";
      isNewConversation = true;
    } else if (
      probe.classification.observation === OBSERVATIONS.ASSISTANT_RUNNING ||
      probe.classification.observation === OBSERVATIONS.USER_PENDING
    ) {
      throw new Error(`worker ${worker.worker_id} is not idle`);
    }
  } else {
    creationReason = "BRAIN_DIRECTIVE_NEW_WORKER";
    isNewConversation = true;
  }

  worker.task_id = action.task_id;
  worker.instruction_digest = action.instruction_digest;
  worker.dispatch_latch = {
    task_id: action.task_id,
    instruction_digest: action.instruction_digest,
    generation: worker.generation + (isNewConversation ? 1 : 0)
  };

  if (isNewConversation) {
    worker.generation += 1;
    worker.status = "CREATING";
    worker.creation_latch = {
      kind: creationReason,
      generation: worker.generation,
      instruction_digest: action.instruction_digest
    };
  } else {
    worker.status = "DISPATCHING";
  }
  registry.workers[action.worker_id] = worker;
  await atomicJsonWrite(registryPath, sanitizeRegistry(registry));

  if (isNewConversation) {
    try {
      page = await adapter.newChatPage("https://chatgpt.com/");
    } catch (error) {
      // newChatPage returns only after page creation/navigation completes.
      // If it failed before returning, no Worker instruction was sent, so the
      // one-shot latches can be cleared safely and the same Brain directive can
      // retry after CDP/browser recovery without risking a duplicate send.
      if (isTransientNavigationError(error)) {
        worker.status = "IDLE";
        worker.awaiting_result = false;
        worker.creation_latch = null;
        worker.dispatch_latch = null;
        registry.workers[worker.worker_id] = worker;
        await atomicJsonWrite(registryPath, sanitizeRegistry(registry));
        await safeLog(logPath, {
          type: "WORKER_CREATE_PRE_SEND_RECOVERABLE",
          role: "worker",
          workerId: worker.worker_id,
          taskId: worker.task_id,
          digest: worker.instruction_digest,
          generation: worker.generation,
          reason: "browser/context closed before Worker instruction send; safe retry allowed"
        });
      }
      throw error;
    }
  }

  const execution = await sendComposerInstruction(page, action.instruction, {
    dryRun: false
  });
  if (!execution.executed) {
    throw new Error(`worker ${worker.worker_id} dispatch failed: ${execution.reason || "unknown"}`);
  }

  if (isNewConversation) {
    worker.target = await waitForTarget(page);
  }
  worker.status = "RUNNING";
  worker.awaiting_result = true;
  worker.relay_inflight_id = null;
  worker.creation_latch = null;
  worker.dispatch_latch = null;
  registry.workers[action.worker_id] = worker;
  await atomicJsonWrite(registryPath, sanitizeRegistry(registry));
  await safeLog(logPath, {
    type: isNewConversation
      ? (worker.generation === 1 ? "WORKER_CREATED_BY_BRAIN" : "WORKER_ROLLOVER_FULL_CONFIRMED")
      : "WORKER_DISPATCHED",
    role: "worker",
    workerId: worker.worker_id,
    taskId: worker.task_id,
    digest: worker.instruction_digest,
    generation: worker.generation
  });
}

async function processBrainResponse({
  adapter,
  page,
  registry,
  projectState,
  config,
  execute,
  registryPath,
  logPath
}) {
  const probe = await adapter.probePage(page);
  if (hardStopObservation(probe.classification.observation)) {
    throw new Error("Brain reached Owner/security boundary");
  }
  if (probe.snapshot.conversationMissing) {
    throw new Error("Brain conversation is missing; rollover denied");
  }
  if (probe.classification.observation !== OBSERVATIONS.RESPONSE_COMPLETE) {
    return false;
  }

  const valid = await captureLatestValidBrainDirective(page, config);
  if (!valid) {
    // ChatGPT may emit normal assistant progress/status turns while the Brain is
    // working. Those turns are intentionally ignored instead of being treated
    // as malformed Brain directives.
    return false;
  }

  const { captured, directive } = valid;
  if (captured.digest === registry.brain.last_processed_digest) {
    registry.brain.awaiting_response = false;
    return true;
  }

  for (const action of directive.actions) {
    await dispatchWorker({
      adapter,
      registry,
      action,
      projectState,
      config,
      execute,
      registryPath,
      logPath
    });
  }

  if (execute) {
    registry.brain.last_processed_digest = captured.digest;
    registry.brain.awaiting_response = false;
    await atomicJsonWrite(registryPath, sanitizeRegistry(registry));
    await safeLog(logPath, {
      type: "BRAIN_DIRECTIVE_APPLIED",
      role: "brain",
      digest: directive.digest,
      chars: captured.chars,
      generation: registry.brain.generation
    });
  }
  return true;
}

async function findReadyWorkerResult(adapter, registry) {
  for (const worker of Object.values(registry.workers || {})) {
    if (!worker.awaiting_result || !worker.target) continue;
    const page = await openTargetPage(adapter, worker.target);
    const probe = await adapter.probePage(page);
    if (hardStopObservation(probe.classification.observation)) {
      throw new Error(`worker ${worker.worker_id} reached Owner/security boundary`);
    }
    if (probe.snapshot.conversationMissing) {
      throw new Error(`worker ${worker.worker_id} conversation is missing; rollover denied`);
    }
    if (probe.classification.observation !== OBSERVATIONS.RESPONSE_COMPLETE) {
      continue;
    }
    const captured = await captureCompletedAssistantTurn(page);
    if (captured) return { worker, captured };
  }
  return null;
}

async function relayWorkerResult({
  adapter,
  brainPage,
  brainProbe,
  registry,
  ready,
  projectState,
  config,
  execute,
  registryPath,
  logPath
}) {
  let page = brainPage;
  if (brainProbe.snapshot.conversationMissing) {
    throw new Error("Brain conversation is missing; rollover denied");
  }
  if (brainProbe.snapshot.conversationFull) {
    page = await rolloverBrain({
      adapter,
      registry,
      projectState,
      config,
      execute,
      registryPath,
      logPath,
      snapshot: brainProbe.snapshot
    });
    return { brainPage: page, relayed: false };
  }
  if (brainProbe.classification.observation !== OBSERVATIONS.RESPONSE_COMPLETE) {
    return { brainPage: page, relayed: false };
  }

  const envelope = buildWorkerResultEnvelope({
    workerId: ready.worker.worker_id,
    taskId: ready.worker.task_id,
    generation: ready.worker.generation,
    turn: ready.captured.turn,
    responseText: ready.captured.text
  });

  if (ready.worker.last_result_relay_id === envelope.relay_id) {
    ready.worker.awaiting_result = false;
    ready.worker.status = "IDLE";
    await atomicJsonWrite(registryPath, sanitizeRegistry(registry));
    return { brainPage: page, relayed: false };
  }

  if (ready.worker.relay_inflight_id) {
    if (ready.worker.relay_inflight_id === envelope.relay_id) {
      throw new Error(`relay ${envelope.relay_id} has an uncertain prior send outcome; exact-once policy denies resend`);
    }
    throw new Error("worker has a conflicting relay-inflight latch");
  }
  if (!execute) return { brainPage: page, relayed: false };

  ready.worker.relay_inflight_id = envelope.relay_id;
  await atomicJsonWrite(registryPath, sanitizeRegistry(registry));

  const execution = await sendComposerInstruction(page, envelope.text, {
    dryRun: false
  });
  if (!execution.executed) {
    throw new Error(`Worker result relay failed: ${execution.reason || "unknown"}`);
  }

  ready.worker.awaiting_result = false;
  ready.worker.status = "IDLE";
  ready.worker.last_result_relay_id = envelope.relay_id;
  ready.worker.last_result_digest = envelope.response_digest;
  ready.worker.relay_inflight_id = null;
  registry.brain.awaiting_response = true;
  await atomicJsonWrite(registryPath, sanitizeRegistry(registry));
  await safeLog(logPath, {
    type: "WORKER_RESULT_RELAYED",
    role: "worker",
    workerId: ready.worker.worker_id,
    taskId: ready.worker.task_id,
    relayId: envelope.relay_id,
    digest: envelope.response_digest,
    chars: envelope.char_count,
    generation: ready.worker.generation
  });

  // The full response body existed only in the local envelope variable and was
  // sent to Brain. It is intentionally not written to logs/status/registry.
  return { brainPage: page, relayed: true };
}

const args = parseArgs(process.argv.slice(2));
if (!args.projectAdapter) throw new Error("--project-adapter is required");
if (!Number.isFinite(args.pollMs) || args.pollMs < 1000) {
  throw new TypeError("poll-ms must be at least 1000");
}

const root = localRoot();
const stopPath = path.join(root, "STOP");
const registryPath = path.join(root, "orchestration.json");
const logPath = path.join(root, "supervisor.log");
const ownerBrainRebindPath = path.join(root, "BRAIN_REBIND.request.json");
const ownerWorkerRetryPath = path.join(root, "WORKER_RETRY.request.json");
const runtimeStatusPath = defaultRuntimeStatusPath();

let registry = await loadRegistry(registryPath);
let projectState = {};
let adapter = null;
let projectStateFetchFailures = 0;

await safeLog(logPath, {
  type: "RUNTIME_BOOT",
  role: "orchestrator",
  reason: `version=${SUPERVISOR_RUNTIME_VERSION};mode=${BRAIN_WORKER_MODE}`
});

try {
  adapter = new ChatGptUiAdapter({ cdpUrl: args.cdpUrl });
  await adapter.open();

  while (true) {
    try {
      await fs.access(stopPath);
      await writeStatus(runtimeStatusPath, projectState, {
        status: "STOPPED",
        workers: registry.workers
      });
      break;
    } catch {}

    try {
      try {
        projectState = await readProjectState(args.projectAdapter);
        projectStateFetchFailures = 0;
      } catch (error) {
        if (!(error instanceof ProjectAdapterFetchError)) throw error;

        projectStateFetchFailures += 1;
        const retryMs = Math.min(
          30_000,
          Math.max(args.pollMs, args.pollMs * (2 ** Math.min(projectStateFetchFailures - 1, 3)))
        );

        await safeLog(logPath, {
          type: "PROJECT_ADAPTER_FETCH_RETRY",
          role: "orchestrator",
          errorName: error.name,
          reason: `${error.message}; retrying automatically in ${retryMs}ms`
        });
        await writeStatus(runtimeStatusPath, projectState, {
          status: "RECOVERING",
          brainStatus: registry.brain.awaiting_response ? "THINKING" : "IDLE",
          workers: registry.workers,
          errorName: error.name,
          reason: "project adapter temporarily unavailable; retrying automatically"
        }).catch(() => {});
        await delay(retryMs);
        continue;
      }

      const config = projectState.supervisor_orchestration || {};

      if (config.mode !== BRAIN_WORKER_MODE) {
        throw new Error("source of truth no longer authorizes BRAIN_WORKER_V1");
      }
      if (projectState.status === "DONE") {
        await writeStatus(runtimeStatusPath, projectState, {
          status: "DONE",
          workers: registry.workers
        });
        await delay(args.pollMs);
        continue;
      }
      if (projectState.autonomy === "PAUSED") {
        await writeStatus(runtimeStatusPath, projectState, {
          status: "PAUSED",
          workers: registry.workers,
          reason: "repository autonomy is PAUSED"
        });
        process.exitCode = 76;
        break;
      }
      if (
        projectState.blocked ||
        projectState.status === "BLOCKED" ||
        projectState.requires_user ||
        projectState.status === "WAIT_USER"
      ) {
        await writeStatus(runtimeStatusPath, projectState, {
          status: "WAIT_USER",
          workers: registry.workers,
          reason: "repository requires Owner intervention"
        });
        await delay(args.pollMs);
        continue;
      }
      if (projectState.autonomy !== "AUTO_CONTINUE") {
        await writeStatus(runtimeStatusPath, projectState, {
          status: "READY",
          workers: registry.workers,
          reason: `autonomy mode is ${projectState.autonomy}`
        });
        await delay(args.pollMs);
        continue;
      }

      let brainPage = await applyOwnerBrainRebind({
        adapter,
        registry,
        config,
        execute: args.execute,
        requestPath: ownerBrainRebindPath,
        registryPath,
        logPath
      });

      if (!brainPage) {
        brainPage = await ensureBrain({
          adapter,
          registry,
          projectState,
          config,
          execute: args.execute,
          registryPath,
          logPath
        });
      }

      if (!args.execute && !registry.brain.target) {
        await writeStatus(runtimeStatusPath, projectState, {
          status: "DRY_RUN",
          brainStatus: "BOOTSTRAP_READY",
          workers: registry.workers
        });
        await delay(args.pollMs);
        continue;
      }

      await applyOwnerWorkerRetry({
        registry,
        requestPath: ownerWorkerRetryPath,
        registryPath,
        logPath
      });

      // Always reconcile the latest completed Brain turn by digest. This is
      // required after a Supervisor/browser restart because Owner may have
      // continued the Brain conversation while the local runtime was offline.
      // processBrainResponse is idempotent for an already-processed digest.
      await processBrainResponse({
        adapter,
        page: brainPage,
        registry,
        projectState,
        config,
        execute: args.execute,
        registryPath,
        logPath
      });

      if (!registry.brain.awaiting_response) {
        const ready = await findReadyWorkerResult(adapter, registry);
        if (ready) {
          const brainProbe = await adapter.probePage(brainPage);
          const relay = await relayWorkerResult({
            adapter,
            brainPage,
            brainProbe,
            registry,
            ready,
            projectState,
            config,
            execute: args.execute,
            registryPath,
            logPath
          });
          brainPage = relay.brainPage;
        }
      }

      await writeStatus(runtimeStatusPath, projectState, {
        status: registry.brain.awaiting_response ? "RUNNING" : "READY",
        brainStatus: registry.brain.awaiting_response ? "THINKING" : "IDLE",
        workers: registry.workers
      });
    } catch (error) {
      await safeLog(logPath, {
        type: "BRAIN_WORKER_ERROR",
        role: "orchestrator",
        errorName: error?.name || "Error",
        reason: String(error?.message || error).slice(0, 240)
      });
      await writeStatus(runtimeStatusPath, projectState, {
        status: "WAIT_USER",
        brainStatus: registry.brain.awaiting_response ? "THINKING" : "ERROR",
        workers: registry.workers,
        errorName: error?.name || "Error",
        reason: String(error?.message || error).slice(0, 240)
      }).catch(() => {});
      await delay(args.pollMs);
    }

    await delay(args.pollMs);
  }
} finally {
  await adapter?.close().catch(() => {});
}
