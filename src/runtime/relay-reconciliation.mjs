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

export function activeRelayScreenshotPaths(registry) {
  const active = new Set();
  for (const lane of Object.values(registry?.lanes || {})) {
    const screenshotPath = String(
      lane?.relay_inflight?.screenshot_path || ""
    ).trim();
    if (screenshotPath) active.add(screenshotPath);
  }
  return active;
}


export function migrateLegacyBlockedRelayLatches(registry) {
  let migrated = 0;
  for (const lane of Object.values(registry?.lanes || {})) {
    const latch = lane?.relay_inflight;
    if (!latch?.reconcile_blocked) continue;
    latch.reconcile_blocked = false;
    delete latch.reconcile_started_at;
    delete latch.reconcile_reloaded;
    delete latch.reconcile_runtime_version;
    migrated += 1;
  }
  return migrated;
}
