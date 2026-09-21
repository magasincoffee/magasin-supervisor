import { ACTIONS, OBSERVATIONS, decideContinuation } from "../decision.mjs";
import { validateProjectState } from "../state.mjs";
import { executeDecision } from "../ui/actions.mjs";

export class SupervisorLoopController {
  constructor({
    execute = false,
    minActionIntervalMs = 15_000,
    handoffIdleConfirmMs = 20_000,
    workIdleConfirmMs = 20_000,
    now = () => Date.now(),
    onEvent = () => {}
  } = {}) {
    this.execute = execute;
    this.minActionIntervalMs = minActionIntervalMs;
    this.handoffIdleConfirmMs = handoffIdleConfirmMs;
    this.workIdleConfirmMs = workIdleConfirmMs;
    this.now = now;
    this.onEvent = onEvent;
    this.armed = true;
    this.lastActionAt = 0;
    this.assistantCountAtAction = null;
    this.turnOrdinalAtAction = null;
    this.sawRunningAfterAction = false;
    this.userPendingSignature = null;
    this.userPendingSince = 0;
    this.userPendingSawProgress = false;
  }

  markExternalContinuation(
    assistantMessageCount = 0,
    target = "EXTERNAL_CONTINUE",
    turnOrdinal = null
  ) {
    this.armed = false;
    this.lastActionAt = this.now();
    this.assistantCountAtAction = Number(assistantMessageCount || 0);
    this.turnOrdinalAtAction =
      turnOrdinal == null ? null : Number(turnOrdinal || 0);
    this.sawRunningAfterAction = false;
    this.resetUserPendingTracker();
    this.onEvent({
      type: "ACTION_EXECUTED",
      action: ACTIONS.CONTINUE,
      target
    });
  }

  resetUserPendingTracker() {
    this.userPendingSignature = null;
    this.userPendingSince = 0;
    this.userPendingSawProgress = false;
  }

  safeActivitySignature(snapshot = {}) {
    return [
      Number(snapshot.maxConversationTurnOrdinal || 0),
      String(snapshot.lastMessageRole || ""),
      Number(snapshot.lastMessageCharCount || 0),
      Number(snapshot.assistantMessageCount || 0)
    ].join("|");
  }

  resolveWorkUiObservation(
    probe,
    { handoff = false, ownerReconcile = false } = {}
  ) {
    const snapshot = probe?.snapshot || {};
    const original = probe?.classification?.observation;
    const signature = this.safeActivitySignature(snapshot);

    if (original === OBSERVATIONS.ASSISTANT_RUNNING) {
      this.userPendingSignature = signature;
      this.userPendingSince = this.now();
      this.userPendingSawProgress = true;
      return {
        observation: original,
        workUiSettled: false
      };
    }

    if (original !== OBSERVATIONS.USER_PENDING) {
      this.resetUserPendingTracker();
      return {
        observation: original,
        workUiSettled: false
      };
    }

    if (snapshot.responseRunning || snapshot.mainBusy) {
      this.userPendingSignature = signature;
      this.userPendingSince = this.now();
      this.userPendingSawProgress = true;
      return {
        observation: original,
        workUiSettled: false
      };
    }

    if (this.userPendingSignature == null) {
      this.userPendingSignature = signature;
      this.userPendingSince = this.now();
      return {
        observation: original,
        workUiSettled: false
      };
    }

    if (signature !== this.userPendingSignature) {
      this.userPendingSignature = signature;
      this.userPendingSince = this.now();
      this.userPendingSawProgress = true;
      return {
        observation: original,
        workUiSettled: false
      };
    }

    const idleFallback = handoff || ownerReconcile;
    const confirmMs = idleFallback
      ? this.handoffIdleConfirmMs
      : this.workIdleConfirmMs;
    const stableLongEnough =
      this.userPendingSince > 0 &&
      this.now() - this.userPendingSince >= confirmMs;
    const maySettle = idleFallback || this.userPendingSawProgress;

    if (stableLongEnough && maySettle) {
      const eventType = ownerReconcile
        ? "OWNER_RECONCILE_IDLE_CONFIRMED"
        : handoff
          ? "HANDOFF_IDLE_CONFIRMED"
          : "WORK_UI_IDLE_CONFIRMED";
      this.onEvent({
        type: eventType,
        reason: ownerReconcile
          ? "WAIT_USER chat is idle; reconcile only an explicit Owner decision into repository state."
          : handoff
            ? "Owner-pending role stayed structurally idle; reconcile the visible conversation instead of waiting forever."
            : "Observed Work UI progress followed by a stable idle window; treat the response as complete."
      });
      return {
        observation: OBSERVATIONS.RESPONSE_COMPLETE,
        workUiSettled: true
      };
    }

    return {
      observation: original,
      workUiSettled: false
    };
  }

  observeProgress(probe) {
    const snapshot = probe?.snapshot || {};
    const classification = probe?.classification || {};

    if (this.armed) return;

    if (classification.observation === "ASSISTANT_RUNNING") {
      this.sawRunningAfterAction = true;
      return;
    }

    const count = Number(snapshot.assistantMessageCount || 0);
    const progressed =
      this.assistantCountAtAction != null &&
      count > this.assistantCountAtAction;
    const turnOrdinal = Number(snapshot.maxConversationTurnOrdinal || 0);
    const semanticTurnProgressed =
      this.turnOrdinalAtAction != null &&
      turnOrdinal > this.turnOrdinalAtAction &&
      snapshot.lastMessageRole === "assistant";

    if (
      classification.observation === "RESPONSE_COMPLETE" &&
      (
        progressed ||
        semanticTurnProgressed ||
        this.sawRunningAfterAction ||
        snapshot.workUiSettled
      )
    ) {
      this.armed = true;
      this.sawRunningAfterAction = false;
      this.assistantCountAtAction = null;
      this.turnOrdinalAtAction = null;
      this.resetUserPendingTracker();
      this.onEvent({
        type: snapshot.workUiSettled
          ? "REARMED_AFTER_WORK_UI"
          : "REARMED_AFTER_RESPONSE"
      });
    }
  }

  async step({
    page,
    projectState,
    probe,
    retryCount = 0,
    maxRetries = 2,
    handoff = false,
    ownerReconcile = false,
    ownerRecheck = false,
    ownerReconcileAwaitingResponse = false
  }) {
    const state = validateProjectState(projectState);
    const resolved = this.resolveWorkUiObservation(probe, {
      handoff,
      ownerReconcile
    });
    const observation = resolved.observation;
    const effectiveProbe = {
      ...probe,
      classification: {
        ...probe.classification,
        observation
      },
      snapshot: {
        ...(probe?.snapshot || {}),
        workUiSettled: resolved.workUiSettled
      }
    };

    this.observeProgress(effectiveProbe);

    if (
      ownerReconcileAwaitingResponse &&
      this.armed &&
      observation === OBSERVATIONS.RESPONSE_COMPLETE
    ) {
      return {
        decision: {
          action: ACTIONS.WAIT,
          reason: "owner reconciliation response completed; await repository refresh"
        },
        execution: {
          executed: false,
          dryRun: !this.execute,
          action: ACTIONS.WAIT,
          reason: "decision requires no UI action"
        },
        effectiveObservation: observation,
        workUiSettled: resolved.workUiSettled
      };
    }

    const decision = decideContinuation({
      projectState: state,
      observation,
      retryCount,
      maxRetries,
      handoff,
      ownerReconcile
    });

    if (decision.action === ACTIONS.CONTINUE) {
      const ownerRecheckMayReleaseProgressLatch =
        ownerReconcile && ownerRecheck;

      if (!this.armed && !ownerRecheckMayReleaseProgressLatch) {
        return {
          decision,
          execution: {
            executed: false,
            dryRun: !this.execute,
            action: decision.action,
            reason: "awaiting observable assistant progress"
          }
        };
      }

      if (!this.armed && ownerRecheckMayReleaseProgressLatch) {
        this.onEvent({
          type: "OWNER_RECHECK_PROGRESS_LATCH_RELEASED",
          reason: "Explicit Owner recheck permits one reconciliation attempt; business/security gates remain unchanged."
        });
      }

      const elapsed = this.now() - this.lastActionAt;
      if (this.lastActionAt > 0 && elapsed < this.minActionIntervalMs) {
        return {
          decision,
          execution: {
            executed: false,
            dryRun: !this.execute,
            action: decision.action,
            reason: "action cooldown active"
          }
        };
      }
    }

    if (decision.action === ACTIONS.RETRY) {
      const elapsed = this.now() - this.lastActionAt;
      if (this.lastActionAt > 0 && elapsed < this.minActionIntervalMs) {
        return {
          decision,
          execution: {
            executed: false,
            dryRun: !this.execute,
            action: decision.action,
            reason: "action cooldown active"
          }
        };
      }
    }

    const execution = await executeDecision({
      page,
      decision,
      dryRun: !this.execute
    });

    if (
      this.execute &&
      execution.executed &&
      (decision.action === ACTIONS.CONTINUE || decision.action === ACTIONS.RETRY)
    ) {
      this.armed = false;
      this.lastActionAt = this.now();
      this.assistantCountAtAction = Number(
        probe?.snapshot?.assistantMessageCount || 0
      );
      this.turnOrdinalAtAction = Number(
        probe?.snapshot?.maxConversationTurnOrdinal || 0
      );
      this.sawRunningAfterAction = false;
      this.resetUserPendingTracker();
      this.onEvent({
        type: "ACTION_EXECUTED",
        action: decision.action,
        target: execution.target || null
      });
    }

    return {
      decision,
      execution,
      effectiveObservation: observation,
      workUiSettled: resolved.workUiSettled
    };
  }
}
