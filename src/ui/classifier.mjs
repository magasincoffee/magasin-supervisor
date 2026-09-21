import { OBSERVATIONS } from "../decision.mjs";

export const UI_STATES = Object.freeze({
  READY_IDLE: "READY_IDLE",
  USER_PENDING: "USER_PENDING",
  RUNNING: "RUNNING",
  LOGIN_REQUIRED: "LOGIN_REQUIRED",
  CAPTCHA: "CAPTCHA",
  NETWORK_ERROR: "NETWORK_ERROR",
  TRANSIENT_ERROR: "TRANSIENT_ERROR",
  UNKNOWN: "UNKNOWN"
});

export function classifyUiSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("UI snapshot must be an object");
  }

  if (snapshot.hasCaptcha) {
    return { uiState: UI_STATES.CAPTCHA, observation: OBSERVATIONS.CAPTCHA };
  }

  if (snapshot.loginRequired) {
    return {
      uiState: UI_STATES.LOGIN_REQUIRED,
      observation: OBSERVATIONS.AUTH_REQUIRED
    };
  }

  if (snapshot.hasNetworkError) {
    return {
      uiState: UI_STATES.NETWORK_ERROR,
      observation: OBSERVATIONS.NETWORK_ERROR
    };
  }

  if (snapshot.hasTransientError || snapshot.hasRetryControl) {
    return {
      uiState: UI_STATES.TRANSIENT_ERROR,
      observation: OBSERVATIONS.TRANSIENT_ERROR
    };
  }

  if (snapshot.responseRunning) {
    return {
      uiState: UI_STATES.RUNNING,
      observation: OBSERVATIONS.ASSISTANT_RUNNING
    };
  }

  if (snapshot.lastMessageRole === "user") {
    return {
      uiState: UI_STATES.USER_PENDING,
      observation: OBSERVATIONS.USER_PENDING
    };
  }

  const hasConversationEvidence =
    Number(snapshot.assistantMessageCount || 0) > 0 ||
    Number(snapshot.userMessageCount || 0) > 0 ||
    Boolean(snapshot.conversationPath);

  if (snapshot.composerReady && hasConversationEvidence) {
    return {
      uiState: UI_STATES.READY_IDLE,
      observation: OBSERVATIONS.RESPONSE_COMPLETE
    };
  }

  return { uiState: UI_STATES.UNKNOWN, observation: OBSERVATIONS.UNKNOWN };
}
