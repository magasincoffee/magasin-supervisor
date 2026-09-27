export const MACHINE_FRAME_PREFIX = "@M ";
export const MACHINE_FRAME_VERSION = 1;
export const MACHINE_FRAME_ACTIONS = Object.freeze([
  "assign",
  "report",
  "accept_assign",
  "reject",
  "blocked",
  "resume",
  "stop",
  "done"
]);

const ACTION_SET = new Set(MACHINE_FRAME_ACTIONS);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

function requireId(value, label) {
  const id = String(value || "").trim();
  if (!ID_RE.test(id)) throw new Error(`invalid ${label}`);
  return id;
}

function normalizeReportStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (!["pass", "fail", "blocked"].includes(status)) {
    throw new Error("invalid report status");
  }
  return status;
}

function normalizeCount(value, label) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > 1000000) {
    throw new Error(`invalid ${label}`);
  }
  return count;
}

function normalizeGeneration(value) {
  const generation = Number(value);
  if (!Number.isInteger(generation) || generation < 1 || generation > 1000000) {
    throw new Error("invalid project_generation");
  }
  return generation;
}

function assertPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("@M payload must be a JSON object");
  }
}

export function parseMachineFrame(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n").trimEnd();
  if (!raw) throw new Error("assistant turn is empty");

  const lines = raw.split("\n");
  let index = lines.length - 1;
  while (index >= 0 && !lines[index].trim()) index -= 1;
  if (index < 0) throw new Error("assistant turn is empty");

  const machineLine = lines[index].trim();
  if (!machineLine.startsWith(MACHINE_FRAME_PREFIX)) {
    throw new Error("assistant turn missing final @M frame");
  }

  const jsonText = machineLine.slice(MACHINE_FRAME_PREFIX.length);
  if (!jsonText.trim()) throw new Error("@M frame JSON is empty");

  const payload = JSON.parse(jsonText);
  assertPlainObject(payload);

  if (payload.v !== MACHINE_FRAME_VERSION) {
    throw new Error("unsupported @M protocol version");
  }

  const action = String(payload.a || "").trim().toLowerCase();
  if (!ACTION_SET.has(action)) throw new Error("unsupported @M action");

  const frame = { v: MACHINE_FRAME_VERSION, a: action };
  if (payload.t !== undefined) frame.t = requireId(payload.t, "task_id");
  if (payload.i !== undefined) frame.i = requireId(payload.i, "assignment_id");
  if (payload.r !== undefined) frame.r = requireId(payload.r, "result_id");
  if (payload.n !== undefined) frame.n = requireId(payload.n, "next_task_id");
  if (payload.s !== undefined) frame.s = normalizeReportStatus(payload.s);
  if (payload.p !== undefined) frame.p = requireId(payload.p, "project_id");
  if (payload.g !== undefined) frame.g = normalizeGeneration(payload.g);
  if (payload.pc !== undefined) frame.pc = normalizeCount(payload.pc, "project_completed_tasks");
  if (payload.pt !== undefined) frame.pt = normalizeCount(payload.pt, "project_total_tasks");
  if ((frame.pc === undefined) !== (frame.pt === undefined)) {
    throw new Error("project progress requires both pc and pt");
  }
  if (frame.pc !== undefined && frame.pc > frame.pt) {
    throw new Error("project_completed_tasks cannot exceed project_total_tasks");
  }

  if (action === "assign" && (!frame.t || !frame.i)) {
    throw new Error("assign requires task_id and assignment_id");
  }
  if (action === "report" && (!frame.t || !frame.i || !frame.r || !frame.s)) {
    throw new Error("report requires task_id, assignment_id, result_id and status");
  }
  if (action === "accept_assign" && (!frame.t || !frame.r || !frame.n || !frame.i)) {
    throw new Error(
      "accept_assign requires reviewed task_id, result_id, next_task_id and new assignment_id"
    );
  }
  if (action === "reject" && (!frame.t || !frame.r)) {
    throw new Error("reject requires task_id and result_id");
  }

  return {
    frame,
    body: lines.slice(0, index).join("\n").trim(),
    raw
  };
}

export function assertMachineFrameAction(frame, allowedActions) {
  const allowed = new Set(
    Array.isArray(allowedActions)
      ? allowedActions.map((value) => String(value || "").trim().toLowerCase())
      : []
  );
  if (!frame || !allowed.has(frame.a)) {
    throw new Error(
      `unexpected @M action: ${String(frame?.a || "missing")}`
    );
  }
  return frame;
}

export function assertMachineFrameCorrelation(frame, {
  taskId = undefined,
  assignmentId = undefined,
  resultId = undefined
} = {}) {
  if (!frame || typeof frame !== "object") {
    throw new Error("@M frame is required for correlation");
  }

  const checks = [
    ["t", taskId, "task_id"],
    ["i", assignmentId, "assignment_id"],
    ["r", resultId, "result_id"]
  ];

  for (const [field, expected, label] of checks) {
    if (expected === undefined || expected === null) continue;
    const normalized = requireId(expected, `expected ${label}`);
    if (frame[field] !== normalized) {
      throw new Error(
        `@M ${label} correlation mismatch: expected ${normalized}`
      );
    }
  }

  return frame;
}

export function machineFrameLine(frame) {
  if (!frame || typeof frame !== "object") {
    throw new TypeError("frame is required");
  }
  return `${MACHINE_FRAME_PREFIX}${JSON.stringify(frame)}`;
}
