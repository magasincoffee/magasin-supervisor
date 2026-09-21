import test from "node:test";
import assert from "node:assert/strict";

import {
  matchesConversationAccessDeniedText
} from "../src/ui/snapshot.mjs";

test("detects Vietnamese conversation access denied banner", () => {
  assert.equal(
    matchesConversationAccessDeniedText(
      "Bạn không có quyền truy cập cuộc trò chuyện này. Hãy đảm bảo bạn đã đăng nhập đúng tài khoản hoặc nhờ chủ sở hữu cuộc trò chuyện gửi cho bạn liên kết chia sẻ."
    ),
    true
  );
});

test("detects English conversation access denied banner", () => {
  assert.equal(
    matchesConversationAccessDeniedText(
      "You don't have access to this conversation. Make sure you're logged in to the correct account or ask the owner to share a link."
    ),
    true
  );
});

test("does not confuse normal conversation text with access denied", () => {
  assert.equal(
    matchesConversationAccessDeniedText("Work completed successfully."),
    false
  );
});
