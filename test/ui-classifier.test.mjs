import test from "node:test";
import assert from "node:assert/strict";

import { OBSERVATIONS } from "../src/decision.mjs";
import { UI_STATES, classifyUiSnapshot } from "../src/ui/classifier.mjs";
import {
  matchesConversationFullText,
  matchesConversationMissingText,
  matchesModelSwitchingText,
  matchesExplicitRetryControl,
  matchesTransientErrorAlert,
  matchesStopControlMetadata
} from "../src/ui/snapshot.mjs";

const base = {
  composerReady: true,
  assistantMessageCount: 1,
  userMessageCount: 1,
  conversationPath: true,
  loginRequired: false,
  hasCaptcha: false,
  responseRunning: false,
  hasNetworkError: false,
  hasTransientError: false
};

test("classifies authenticated idle conversation as response complete", () => {
  const result = classifyUiSnapshot(base);
  assert.equal(result.uiState, UI_STATES.READY_IDLE);
  assert.equal(result.observation, OBSERVATIONS.RESPONSE_COMPLETE);
});

test("does not continue from empty home composer without conversation evidence", () => {
  const result = classifyUiSnapshot({
    ...base,
    assistantMessageCount: 0,
    userMessageCount: 0,
    conversationPath: false
  });
  assert.equal(result.uiState, UI_STATES.UNKNOWN);
  assert.equal(result.observation, OBSERVATIONS.UNKNOWN);
});

test("captcha takes precedence and hard-stops", () => {
  const result = classifyUiSnapshot({ ...base, hasCaptcha: true });
  assert.equal(result.uiState, UI_STATES.CAPTCHA);
  assert.equal(result.observation, OBSERVATIONS.CAPTCHA);
});

test("login required maps to auth-required observation", () => {
  const result = classifyUiSnapshot({
    ...base,
    composerReady: false,
    loginRequired: true
  });
  assert.equal(result.uiState, UI_STATES.LOGIN_REQUIRED);
  assert.equal(result.observation, OBSERVATIONS.AUTH_REQUIRED);
});

test("running response never classifies as complete", () => {
  const result = classifyUiSnapshot({ ...base, responseRunning: true });
  assert.equal(result.uiState, UI_STATES.RUNNING);
  assert.equal(result.observation, OBSERVATIONS.ASSISTANT_RUNNING);
});

test("network errors map to bounded-retry observation", () => {
  const result = classifyUiSnapshot({ ...base, hasNetworkError: true });
  assert.equal(result.uiState, UI_STATES.NETWORK_ERROR);
  assert.equal(result.observation, OBSERVATIONS.NETWORK_ERROR);
});


test("explicit retry control is transient even when error banner parsing misses", () => {
  const result = classifyUiSnapshot({
    composerReady: true,
    assistantMessageCount: 1,
    userMessageCount: 1,
    conversationPath: true,
    loginRequired: false,
    hasCaptcha: false,
    responseRunning: false,
    hasNetworkError: false,
    hasTransientError: false,
    hasRetryControl: true
  });
  assert.equal(result.uiState, UI_STATES.TRANSIENT_ERROR);
  assert.equal(result.observation, OBSERVATIONS.TRANSIENT_ERROR);
});


test("recognizes the Vietnamese max-duration banner as a full conversation", () => {
  assert.equal(
    matchesConversationFullText(
      "Bạn đã đạt đến thời lượng tối đa cho cuộc trò chuyện này nhưng bạn có thể tiếp tục trò chuyện bằng cách bắt đầu một đoạn chat mới."
    ),
    true
  );
});

test("recognizes explicit new-chat continuation surfaces as conversation rollover", () => {
  assert.equal(
    matchesConversationFullText("Start a new chat to continue this conversation"),
    true
  );
  assert.equal(
    matchesConversationFullText("Bắt đầu cuộc trò chuyện mới để tiếp tục"),
    true
  );
});

test("recognizes missing/unavailable conversation surfaces", () => {
  assert.equal(
    matchesConversationMissingText("This conversation is unavailable"),
    true
  );
  assert.equal(
    matchesConversationMissingText("Không thể tải cuộc trò chuyện"),
    true
  );
});

test("recognizes model switching as a running recovery surface", () => {
  assert.equal(matchesModelSwitchingText("Switching to another model"), true);
  assert.equal(matchesModelSwitchingText("Đang chuyển sang mô hình khác"), true);
});


test("retry detector ignores advisory wording containing 'thử lại' when it is not an explicit retry control", () => {
  assert.equal(
    matchesExplicitRetryControl(
      "Bạn có thể thử lại với mô hình nhanh hơn để nhận phản hồi sớm hơn"
    ),
    false
  );
  assert.equal(matchesExplicitRetryControl("Thử lại"), true);
  assert.equal(matchesExplicitRetryControl("Try again"), true);
  assert.equal(matchesExplicitRetryControl("Retry"), true);
});

test("transient error detector requires an actual error alert phrase", () => {
  assert.equal(
    matchesTransientErrorAlert("Bạn có thể thử lại với mô hình nhanh hơn"),
    false
  );
  assert.equal(matchesTransientErrorAlert("Something went wrong"), true);
  assert.equal(matchesTransientErrorAlert("Đã xảy ra lỗi"), true);
});


test("waits when the latest visible message is the Owner and ChatGPT has not answered yet", () => {
  const result = classifyUiSnapshot({
    ...base,
    responseRunning: false,
    hasTransientError: false,
    hasRetryControl: false,
    lastMessageRole: "user"
  });

  assert.equal(result.uiState, UI_STATES.USER_PENDING);
  assert.equal(result.observation, OBSERVATIONS.USER_PENDING);
});

test("completed assistant message remains ready for handoff", () => {
  const result = classifyUiSnapshot({
    ...base,
    lastMessageRole: "assistant"
  });

  assert.equal(result.uiState, UI_STATES.READY_IDLE);
  assert.equal(result.observation, OBSERVATIONS.RESPONSE_COMPLETE);
});


test("recognizes ChatGPT Work stop-button as an active response control", () => {
  assert.equal(
    matchesStopControlMetadata({ testId: "stop-button", text: "", ariaLabel: "" }),
    true
  );
  assert.equal(
    matchesStopControlMetadata({ testId: "send-button", text: "", ariaLabel: "Send prompt" }),
    false
  );
  assert.equal(
    matchesStopControlMetadata({ text: "Dừng phản hồi" }),
    true
  );
});
