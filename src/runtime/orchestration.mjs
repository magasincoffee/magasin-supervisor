import crypto from "node:crypto";

export const BRAIN_WORKER_MODE = "BRAIN_WORKER_V1";
export const BRAIN_DIRECTIVE_START = "<<<MAGASIN_BRAIN_DIRECTIVE_V1>>>";
export const BRAIN_DIRECTIVE_END = "<<<END_MAGASIN_BRAIN_DIRECTIVE_V1>>>";
export const WORKER_RESULT_START = "<<<MAGASIN_WORKER_RESULT_V1>>>";
export const WORKER_RESULT_END = "<<<END_MAGASIN_WORKER_RESULT_V1>>>";

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:\/-]{0,79}$/;

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function requireSafeId(value, field) {
  const text = String(value || "").trim();
  if (!SAFE_ID_RE.test(text)) {
    throw new Error(`invalid ${field}`);
  }
  return text;
}

export function parseBrainDirective(text, { maxWorkers = 3 } = {}) {
  const raw = String(text || "");
  const start = raw.lastIndexOf(BRAIN_DIRECTIVE_START);
  const end = raw.indexOf(BRAIN_DIRECTIVE_END, start + BRAIN_DIRECTIVE_START.length);
  if (start < 0 || end < 0) {
    throw new Error("brain response missing MAGASIN_BRAIN_DIRECTIVE_V1 block");
  }

  const jsonText = raw
    .slice(start + BRAIN_DIRECTIVE_START.length, end)
    .trim();
  const payload = JSON.parse(jsonText);
  if (!payload || !Array.isArray(payload.actions)) {
    throw new Error("brain directive actions must be an array");
  }
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 12) {
    throw new Error("maxWorkers must be between 1 and 12");
  }
  if (payload.actions.length > maxWorkers) {
    throw new Error("brain directive exceeds max worker action budget");
  }

  const seenWorkers = new Set();
  const actions = payload.actions.map((action) => {
    if (!action || action.type !== "DISPATCH") {
      throw new Error("unsupported brain action");
    }
    const workerId = requireSafeId(action.worker_id, "worker_id");
    const taskId = requireSafeId(action.task_id, "task_id");
    const instruction = String(action.instruction || "").trim();
    if (!instruction) throw new Error("brain DISPATCH instruction is empty");
    if (seenWorkers.has(workerId)) {
      throw new Error("brain directive dispatches the same worker more than once");
    }
    seenWorkers.add(workerId);
    return {
      type: "DISPATCH",
      worker_id: workerId,
      task_id: taskId,
      instruction,
      instruction_digest: sha256(instruction)
    };
  });

  return {
    schema_version: "brain-directive.v1",
    actions,
    digest: sha256(jsonText)
  };
}

export function buildBrainBootstrapInstruction(projectState = {}) {
  const orchestration = projectState.supervisor_orchestration || {};
  const maxWorkers = Number(orchestration?.workers?.max_parallel_workers || 3);
  const task = String(projectState.current_task || "");
  const title = String(projectState.current_task_title || "");
  const configured = String(projectState?.instructions?.brain_bootstrap || "").trim();
  const projectPolicy = configured ||
    "Read the project's explicit source-of-truth through the configured project adapter. " +
    "Do not invent project policy or bypass Owner/security boundaries.";
  return [
    "You are the Supervisor Brain orchestration conversation.",
    "Delegate bounded independent work to Workers when safe; do not duplicate Worker execution in the Brain.",
    "Each Worker receives a dynamic instruction for the currently authorized task.",
    `Current task: ${task} — ${title}. Max parallel workers: ${maxWorkers}.`,
    projectPolicy,
    "When dispatching work, end the response with exactly one machine-readable block:",
    BRAIN_DIRECTIVE_START,
    '{"actions":[{"type":"DISPATCH","worker_id":"worker-1","task_id":"TASK-ID/A","instruction":"Complete, bounded instruction for this Worker."}]}',
    BRAIN_DIRECTIVE_END,
    `Dispatch at most ${maxWorkers} distinct Workers. If no safe work is available, use {"actions":[]}.`,
    "When MAGASIN_WORKER_RESULT_V1 arrives, use relay_id for duplicate protection and reconcile only through project-owned source-of-truth.",
    "Do not ask Supervisor to guess the task. Conversation creation/rollover remains Supervisor-controlled."
  ].join("\n");
}

export function buildBrainRolloverInstruction(projectState = {}, registry = {}) {
  const workers = Object.values(registry.workers || {}).map((worker) => ({
    worker_id: worker.worker_id,
    task_id: worker.task_id || null,
    status: worker.status || "IDLE",
    generation: Number(worker.generation || 0),
    awaiting_result: Boolean(worker.awaiting_result),
    last_result_relay_id: worker.last_result_relay_id || null
  }));
  return [
    buildBrainBootstrapInstruction(projectState),
    "",
    "This is a Brain rollover because the prior Brain conversation reported conversationFull.",
    "Restore orchestration only from configured project inputs and the safe local metadata below; do not infer prior message content:",
    JSON.stringify({ workers }, null, 2)
  ].join("\n");
}

export function buildWorkerResultEnvelope({
  workerId,
  taskId,
  generation = 0,
  turn = 0,
  responseText
}) {
  const body = String(responseText ?? "");
  if (!body.trim()) throw new Error("worker response is empty");
  const responseDigest = sha256(body);
  const relayId = sha256([
    workerId,
    taskId,
    generation,
    turn,
    responseDigest
  ].join("|")).slice(0, 32);

  return {
    relay_id: relayId,
    response_digest: responseDigest,
    char_count: body.length,
    text: [
      WORKER_RESULT_START,
      `worker_id=${workerId}`,
      `task_id=${taskId}`,
      `generation=${Number(generation || 0)}`,
      `relay_id=${relayId}`,
      `turn=${Number(turn || 0)}`,
      `chars=${body.length}`,
      "",
      body,
      WORKER_RESULT_END
    ].join("\n")
  };
}

export function canCreateWorker({
  registry = {},
  workerId,
  maxWorkers = 3,
  brainDirectiveValidated = false
}) {
  if (!brainDirectiveValidated) return false;
  if (registry.workers?.[workerId]) return true;
  return Object.keys(registry.workers || {}).length < maxWorkers;
}

export function assertRolloverAuthorized(snapshot = {}) {
  if (!snapshot.conversationFull) {
    throw new Error("new conversation rollover denied: conversationFull evidence is absent");
  }
  return true;
}

export function newRegistry() {
  return {
    schema_version: "brain-worker-runtime.v1",
    mode: BRAIN_WORKER_MODE,
    brain: {
      target: null,
      generation: 0,
      awaiting_response: false,
      last_processed_digest: null,
      bootstrap_consumed: false,
      creation_latch: null
    },
    workers: {}
  };
}

export function sanitizeRegistry(registry = {}) {
  const safe = newRegistry();
  safe.brain = {
    target: registry?.brain?.target || null,
    generation: Number(registry?.brain?.generation || 0),
    awaiting_response: Boolean(registry?.brain?.awaiting_response),
    last_processed_digest: registry?.brain?.last_processed_digest || null,
    bootstrap_consumed: Boolean(registry?.brain?.bootstrap_consumed),
    creation_latch: registry?.brain?.creation_latch || null
  };

  for (const [key, worker] of Object.entries(registry.workers || {})) {
    safe.workers[key] = {
      worker_id: String(worker.worker_id || key),
      target: worker.target || null,
      generation: Number(worker.generation || 0),
      task_id: worker.task_id || null,
      status: worker.status || "IDLE",
      awaiting_result: Boolean(worker.awaiting_result),
      instruction_digest: worker.instruction_digest || null,
      last_result_relay_id: worker.last_result_relay_id || null,
      last_result_digest: worker.last_result_digest || null,
      relay_inflight_id: worker.relay_inflight_id || null,
      creation_latch: worker.creation_latch || null,
      dispatch_latch: worker.dispatch_latch || null,
      owner_retry_instruction_digest: worker.owner_retry_instruction_digest || null
    };
  }
  return safe;
}
