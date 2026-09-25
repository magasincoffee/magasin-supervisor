import fs from "node:fs/promises";
import path from "node:path";

export const SUPERVISOR_LOG_SCHEMA_VERSION = "supervisor-log.v1";
export const SUPERVISOR_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const SUPERVISOR_LOG_TAIL_LINES = 800;

const HEX_RE = /^[a-f0-9]{16,128}$/i;
const SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const SAFE_REASON_RE = /^[A-Za-z0-9_.:=;|/-]{1,180}$/;
const LANE_RE = /^lane-[1-3]$/;

function safeToken(value) {
  const raw = String(value || "").trim();
  if (!SAFE_TOKEN_RE.test(raw)) return undefined;
  return raw;
}

function safeTask(value) {
  const raw = String(value || "").trim();
  if (
    !SAFE_TASK_RE.test(raw) ||
    raw.includes("://") ||
    raw.includes("\\") ||
    raw.includes("..") ||
    raw.includes("//") ||
    /^[A-Za-z]:\//.test(raw)
  ) {
    return undefined;
  }
  return raw;
}

function safeHex(value) {
  const raw = String(value || "").trim();
  if (raw === "NONE") return raw;
  return HEX_RE.test(raw) ? raw : undefined;
}

function safeReason(value) {
  const raw = String(value || "").trim();
  if (
    !SAFE_REASON_RE.test(raw) ||
    raw.includes("://") ||
    raw.includes("\\") ||
    raw.includes("..") ||
    raw.includes("//") ||
    /(token|cookie|secret|password|bearer|authorization|api[_-]?key|session)/i.test(raw)
  ) {
    return undefined;
  }
  return raw;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function signedInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
}

function portNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 65535
    ? number
    : undefined;
}

export function sanitizeSupervisorLogEvent(
  event = {},
  {
    now = () => new Date(),
    runtimeVersion = "UNKNOWN"
  } = {}
) {
  const type = safeToken(event.type) || "EVENT";
  const runtime = safeToken(runtimeVersion) || "UNKNOWN";

  const output = {
    schema_version: SUPERVISOR_LOG_SCHEMA_VERSION,
    timestamp: now().toISOString(),
    type,
    runtime_version: runtime
  };

  const laneId = String(event.laneId || "").trim();
  if (LANE_RE.test(laneId)) output.lane_id = laneId;

  const taskId = safeTask(event.taskId);
  if (taskId) output.task_id = taskId;

  const generation = nonNegativeInteger(
    event.generation ?? event.workGeneration
  );
  if (generation !== undefined) output.work_generation = generation;

  const workRevision = nonNegativeInteger(
    event.workUrlRevision ?? event.work_url_revision
  );
  if (workRevision !== undefined) {
    output.work_url_revision = workRevision;
  }

  const dispatchId = safeHex(event.dispatchId ?? event.dispatch_id);
  if (dispatchId) output.dispatch_id = dispatchId;

  const relayId = safeHex(event.relayId ?? event.relay_id);
  if (relayId) output.relay_id = relayId;

  const digest = safeHex(event.digest);
  if (digest) output.digest = digest;

  const reasonCode = safeToken(event.reasonCode ?? event.reason_code);
  if (reasonCode) output.reason_code = reasonCode;

  const reason = safeReason(event.reason);
  if (reason) output.reason = reason;

  const revision = nonNegativeInteger(event.revision);
  if (revision !== undefined) output.revision = revision;

  const turn = nonNegativeInteger(event.turn);
  if (turn !== undefined) output.turn = turn;

  const errorName = safeToken(event.errorName ?? event.error_name);
  if (errorName) output.error_name = errorName;

  const nodeExitCode = signedInteger(
    event.nodeExitCode ?? event.node_exit_code
  );
  if (nodeExitCode !== undefined) output.node_exit_code = nodeExitCode;

  const cdpPort = portNumber(event.cdpPort ?? event.cdp_port);
  if (cdpPort !== undefined) output.cdp_port = cdpPort;

  return output;
}

async function trimLogIfNeeded(
  filePath,
  {
    maxBytes = SUPERVISOR_LOG_MAX_BYTES,
    tailLines = SUPERVISOR_LOG_TAIL_LINES
  } = {}
) {
  let stat = null;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stat.size <= maxBytes) return;

  const text = await fs.readFile(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-tailLines).join("\n");
  await fs.writeFile(filePath, tail ? tail + "\n" : "", "utf8");
}

export async function appendSanitizedSupervisorLog(
  filePath,
  event = {},
  {
    now,
    runtimeVersion = "UNKNOWN",
    maxBytes,
    tailLines
  } = {}
) {
  const safe = sanitizeSupervisorLogEvent(event, {
    now: now || (() => new Date()),
    runtimeVersion
  });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await trimLogIfNeeded(filePath, { maxBytes, tailLines });
  await fs.appendFile(filePath, JSON.stringify(safe) + "\n", "utf8");
  return safe;
}
