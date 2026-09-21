import fs from "node:fs";
import { fileURLToPath } from "node:url";

const DISPATCH = "WORK_DISPATCH_CONFIRMED";
const RELAY = "RESULT_RELAY_CONFIRMED";
const ACCEPT = new Set(["BRAIN_RESULT_ACCEPTED", "BRAIN_RESULT_REJECTED"]);
const ORDER = new Map([
  ["BRAIN_TASK_ASSIGNED", 10],
  [DISPATCH, 20],
  ["WORK_STARTED", 30],
  ["WORK_ACTIVITY", 40],
  ["WORK_COMPLETED", 50],
  [RELAY, 60],
  ["BRAIN_RESULT_ACCEPTED", 70],
  ["BRAIN_RESULT_REJECTED", 70]
]);

function keyOf(event) {
  return [
    String(event.lane_id || ""),
    String(event.task_id || ""),
    String(event.work_generation ?? 0)
  ].join("|");
}

function assertSafeEvent(event) {
  const text = JSON.stringify(event);
  if (/https?:\/\//i.test(text)) throw new Error("private URL-like data in event stream");
  if (/(cookie|authorization|token|message_body|message_text|screenshot_path|profile_path)/i.test(text)) {
    throw new Error("forbidden private field in event stream");
  }
}

export function validateReleaseEvents(events = []) {
  const dispatchIds = new Set();
  const relayIds = new Set();
  const state = new Map();
  let dispatchConfirmed = 0;
  let relayConfirmed = 0;
  let accepted = 0;
  let rejected = 0;

  for (const raw of events) {
    const event = raw && typeof raw === "object" ? raw : {};
    assertSafeEvent(event);
    const type = String(event.event_type || "");
    const key = keyOf(event);
    const current = state.get(key) || { max: 0, relayIds: new Set() };
    const rank = ORDER.get(type) || 0;

    if (type === DISPATCH) {
      const id = String(event.dispatch_id || "");
      if (!id) throw new Error("confirmed dispatch missing dispatch_id");
      const idKey = key + "|" + id;
      if (dispatchIds.has(idKey)) throw new Error("duplicate confirmed dispatch correlation");
      dispatchIds.add(idKey);
      dispatchConfirmed += 1;
      if (current.max < 10) throw new Error("dispatch confirmed before assignment");
    }

    if (type === "WORK_STARTED" || type === "WORK_ACTIVITY") {
      if (current.max < 20) throw new Error("work progress before confirmed dispatch");
    }

    if (type === "WORK_COMPLETED" && current.max < 20) {
      throw new Error("work completed before confirmed dispatch");
    }

    if (type === RELAY) {
      const id = String(event.relay_id || "");
      if (!id) throw new Error("confirmed relay missing relay_id");
      const idKey = key + "|" + id;
      if (relayIds.has(idKey)) throw new Error("duplicate confirmed relay correlation");
      relayIds.add(idKey);
      current.relayIds.add(id);
      relayConfirmed += 1;
      if (current.max < 50) throw new Error("relay confirmed before work completion");
    }

    if (ACCEPT.has(type)) {
      const id = String(event.relay_id || "");
      if (!id || !current.relayIds.has(id)) {
        throw new Error("Brain verdict before matching relay confirmation");
      }
      if (type === "BRAIN_RESULT_ACCEPTED") accepted += 1;
      else rejected += 1;
    }

    if (type === "WORK_ROLLOVER_DISPATCH_CONFIRMED" && current.maxRolloverPersisted !== true) {
      throw new Error("rollover dispatch confirmed before target persisted");
    }
    if (type === "WORK_ROLLOVER_TARGET_PERSISTED") current.maxRolloverPersisted = true;

    if (rank) current.max = Math.max(current.max, rank);
    state.set(key, current);
  }

  return {
    dispatch_confirmed: dispatchConfirmed,
    relay_confirmed: relayConfirmed,
    brain_accepted: accepted,
    brain_rejected: rejected,
    duplicate_dispatch: false,
    duplicate_relay: false
  };
}

export function parseNdjson(text = "") {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: node supervisor-release-event-validator.mjs FILE");
  const events = parseNdjson(fs.readFileSync(file, "utf8"));
  const result = validateReleaseEvents(events);
  console.log("SOAK_NO_DUPLICATE_DISPATCH=True");
  console.log("SOAK_NO_DUPLICATE_RELAY=True");
  console.log("SOAK_EVENT_ORDER_VALID=True");
  console.log("SOAK_DISPATCH_CONFIRMED_COUNT=" + result.dispatch_confirmed);
  console.log("SOAK_RELAY_CONFIRMED_COUNT=" + result.relay_confirmed);
}
