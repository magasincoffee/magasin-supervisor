export const RECOVERY_ACTIONS = Object.freeze({
  NONE: "NONE",
  WAIT_TARGET: "WAIT_TARGET",
  RELOAD_STALLED: "RELOAD_STALLED",
  RELOAD_UNAVAILABLE: "RELOAD_UNAVAILABLE",
  ROLLOVER_CONVERSATION_FULL: "ROLLOVER_CONVERSATION_FULL",
  WAIT_USER_RECOVERY_EXHAUSTED: "WAIT_USER_RECOVERY_EXHAUSTED"
});

export function isConversationPathname(pathname) {
  return typeof pathname === "string" &&
    /^\/(c|g|project)\//.test(pathname);
}

export function canonicalConversationPathname(pathname) {
  const raw = String(pathname || "");
  const match = raw.match(/^\/c\/WEB:([0-9a-fA-F-]{36})$/);
  if (match) return `/c/${match[1]}`;
  return raw;
}

export function conversationIdentityPathname(pathname) {
  const canonical = canonicalConversationPathname(pathname);
  if (!isConversationPathname(canonical)) return canonical;

  // ChatGPT can expose the same conversation either as /c/<id> or inside
  // a Project/GPT route such as /g/g-p-.../c/<id>. Target identity must
  // follow the conversation id, not the presentation/container pathname.
  const nested = canonical.match(/\/c\/(?:WEB:)?([0-9a-fA-F-]{36})\/?$/);
  if (nested) return `/c/${nested[1]}`;
  return canonical;
}

export function isPersistableConversationUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    targetFromUrl(url);
    return !/\/c\/WEB:/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function targetFromUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== "https:" ||
      (url.hostname !== "chatgpt.com" && !url.hostname.endsWith(".chatgpt.com")) ||
      !isConversationPathname(url.pathname)) {
    throw new Error("invalid ChatGPT conversation URL");
  }
  return {
    origin: "https://chatgpt.com",
    pathname: conversationIdentityPathname(url.pathname)
  };
}

export function pageMatchesTarget(value, target) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return url.origin === target?.origin &&
      conversationIdentityPathname(url.pathname) ===
      conversationIdentityPathname(target?.pathname);
  } catch {
    return false;
  }
}

function isUnavailableSnapshot(snapshot = {}) {
  return Boolean(snapshot.conversationPath) &&
    !snapshot.composerReady &&
    !snapshot.responseRunning &&
    !snapshot.loginRequired &&
    !snapshot.hasCaptcha &&
    !snapshot.hasNetworkError &&
    !snapshot.hasTransientError;
}

export class SupervisorRecoveryController {
  constructor({
    stallMs = 6 * 60_000,
    unavailableGraceMs = 90_000,
    reloadCooldownMs = 45_000,
    targetMissThreshold = 2,
    maxStallReloads = 2,
    maxUnavailableReloads = 1,
    maxRolloverFailures = 3,
    rolloverCooldownMs = 120_000,
    now = () => Date.now()
  } = {}) {
    this.stallMs = stallMs;
    this.unavailableGraceMs = unavailableGraceMs;
    this.reloadCooldownMs = reloadCooldownMs;
    this.targetMissThreshold = targetMissThreshold;
    this.maxStallReloads = maxStallReloads;
    this.maxUnavailableReloads = maxUnavailableReloads;
    this.maxRolloverFailures = maxRolloverFailures;
    this.rolloverCooldownMs = rolloverCooldownMs;
    this.now = now;

    this.runningSince = null;
    this.lastProgressMarker = null;
    this.unavailableSince = null;
    this.lastReloadAt = 0;
    this.stallReloads = 0;
    this.unavailableReloads = 0;
    this.targetMisses = 0;
    this.rolloverFailures = 0;
    this.conversationGeneration = 0;
    this.lastRolloverAt = 0;
    this.rolloverBurstCount = 0;
    this.blocked = false;
  }

  observeTarget({ matched }) {
    if (this.blocked) {
      return RECOVERY_ACTIONS.WAIT_USER_RECOVERY_EXHAUSTED;
    }

    if (matched) {
      this.targetMisses = 0;
      return RECOVERY_ACTIONS.NONE;
    }

    this.targetMisses += 1;
    if (this.targetMisses >= this.targetMissThreshold) {
      this.blocked = true;
      return RECOVERY_ACTIONS.WAIT_USER_RECOVERY_EXHAUSTED;
    }
    return RECOVERY_ACTIONS.WAIT_TARGET;
  }

  observeProbe({ snapshot = {}, classification = {} }) {
    if (this.blocked) {
      return RECOVERY_ACTIONS.WAIT_USER_RECOVERY_EXHAUSTED;
    }

    const now = this.now();
    const rolloverCoolingDown =
      this.lastRolloverAt > 0 &&
      now - this.lastRolloverAt < this.rolloverCooldownMs;

    if (snapshot.conversationMissing) {
      this.blocked = true;
      return RECOVERY_ACTIONS.WAIT_USER_RECOVERY_EXHAUSTED;
    }

    if (snapshot.conversationFull) {
      if (this.rolloverBurstCount >= 2 && !rolloverCoolingDown) {
        this.blocked = true;
        return RECOVERY_ACTIONS.WAIT_USER_RECOVERY_EXHAUSTED;
      }
      if (rolloverCoolingDown) return RECOVERY_ACTIONS.NONE;
      return RECOVERY_ACTIONS.ROLLOVER_CONVERSATION_FULL;
    }
    const observation = classification.observation;

    if (observation === "RESPONSE_COMPLETE") {
      this.rolloverBurstCount = 0;
    }

    if (observation === "ASSISTANT_RUNNING") {
      const progressMarker = `${Number(snapshot.assistantMessageCount || 0)}:${Number(snapshot.lastAssistantCharCount || 0)}`;
      if (this.runningSince == null || progressMarker !== this.lastProgressMarker) {
        this.runningSince = now;
        this.lastProgressMarker = progressMarker;
        // Do not reset stallReloads here. After a reload, ChatGPT hydration/model
        // switching can temporarily change message counts/lengths even though the
        // same response is still stuck. Reset the bounded reload budget only once
        // the response actually leaves ASSISTANT_RUNNING.
      }
      this.unavailableSince = null;
      this.unavailableReloads = 0;

      const elapsed = now - this.runningSince;
      const cooldownElapsed =
        this.lastReloadAt === 0 ||
        now - this.lastReloadAt >= this.reloadCooldownMs;

      if (elapsed >= this.stallMs && cooldownElapsed) {
        if (this.stallReloads < this.maxStallReloads) {
          return RECOVERY_ACTIONS.RELOAD_STALLED;
        }
        this.blocked = true;
        return RECOVERY_ACTIONS.WAIT_USER_RECOVERY_EXHAUSTED;
      }

      return RECOVERY_ACTIONS.NONE;
    }

    this.runningSince = null;
    this.lastProgressMarker = null;
    this.stallReloads = 0;

    if (isUnavailableSnapshot(snapshot)) {
      if (this.unavailableSince == null) this.unavailableSince = now;
      const elapsed = now - this.unavailableSince;
      const cooldownElapsed =
        this.lastReloadAt === 0 ||
        now - this.lastReloadAt >= this.reloadCooldownMs;

      if (elapsed >= this.unavailableGraceMs && cooldownElapsed) {
        if (this.unavailableReloads < this.maxUnavailableReloads) {
          return RECOVERY_ACTIONS.RELOAD_UNAVAILABLE;
        }
        this.blocked = true;
        return RECOVERY_ACTIONS.WAIT_USER_RECOVERY_EXHAUSTED;
      }

      return RECOVERY_ACTIONS.NONE;
    }

    this.unavailableSince = null;
    this.unavailableReloads = 0;
    return RECOVERY_ACTIONS.NONE;
  }

  record(action, { success = true } = {}) {
    const now = this.now();

    if (action === RECOVERY_ACTIONS.RELOAD_STALLED) {
      this.stallReloads += 1;
      this.lastReloadAt = now;
      return;
    }

    if (action === RECOVERY_ACTIONS.RELOAD_UNAVAILABLE) {
      this.unavailableReloads += 1;
      this.lastReloadAt = now;
      return;
    }

    if (action === RECOVERY_ACTIONS.ROLLOVER_CONVERSATION_FULL) {
      if (success) {
        this.conversationGeneration += 1;
        this.lastRolloverAt = now;
        this.rolloverBurstCount += 1;
        this.rolloverFailures = 0;
        this.targetMisses = 0;
        this.runningSince = null;
        this.lastProgressMarker = null;
        this.unavailableSince = null;
        this.lastReloadAt = 0;
        this.stallReloads = 0;
        this.unavailableReloads = 0;
        this.blocked = false;
      } else {
        this.rolloverFailures += 1;
        if (this.rolloverFailures >= this.maxRolloverFailures) {
          this.blocked = true;
        }
      }
    }
  }

  noteConversationAdopted() {
    this.conversationGeneration += 1;
    this.lastRolloverAt = this.now();
    this.rolloverBurstCount += 1;
    this.targetMisses = 0;
    this.runningSince = null;
    this.lastProgressMarker = null;
    this.unavailableSince = null;
    this.lastReloadAt = 0;
    this.stallReloads = 0;
    this.unavailableReloads = 0;
    this.rolloverFailures = 0;
    this.blocked = false;
  }

  status(action = RECOVERY_ACTIONS.NONE) {
    return {
      action,
      stall_reloads: this.stallReloads,
      unavailable_reloads: this.unavailableReloads,
      target_misses: this.targetMisses,
      rollover_failures: this.rolloverFailures,
      conversation_generation: this.conversationGeneration,
      rollover_cooldown_active:
        this.lastRolloverAt > 0 &&
        this.now() - this.lastRolloverAt < this.rolloverCooldownMs,
      rollover_burst_count: this.rolloverBurstCount,
      blocked: this.blocked
    };
  }
}
