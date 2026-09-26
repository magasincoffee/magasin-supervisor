export const RELAY_RECONCILE_OUTCOMES = Object.freeze({
  CONFIRMED: "CONFIRMED",
  NOT_CONFIRMED: "NOT_CONFIRMED",
  PENDING: "PENDING"
});

export function classifyRelayMarkerState({
  markerPresent = false,
  brainStable = false
} = {}) {
  if (markerPresent) return RELAY_RECONCILE_OUTCOMES.CONFIRMED;
  if (!brainStable) return RELAY_RECONCILE_OUTCOMES.PENDING;
  return RELAY_RECONCILE_OUTCOMES.NOT_CONFIRMED;
}

export function migrateLegacyBlockedRelayLatches(registry) {
  let migrated = 0;
  for (const lane of Object.values(registry?.lanes || {})) {
    const latch = lane?.relay_inflight;
    if (!latch) continue;

    let changed = false;
    if (latch.reconcile_blocked) {
      latch.reconcile_blocked = false;
      delete latch.reconcile_started_at;
      delete latch.reconcile_reloaded;
      delete latch.reconcile_runtime_version;
      changed = true;
    }

    // RBT-010: screenshot files are no longer part of relay authority.
    // Preserve relay identity/retry state while removing only the obsolete
    // transport field from legacy persisted latches.
    if (Object.prototype.hasOwnProperty.call(latch, "screenshot_path")) {
      delete latch.screenshot_path;
      changed = true;
    }

    if (changed) migrated += 1;
  }
  return migrated;
}
