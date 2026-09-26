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

test("safe snapshot recognizes modern ChatGPT user and assistant message DOM", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/ui/snapshot.mjs", import.meta.url), "utf8")
  );

  assert.match(source, /text-size-chat\.whitespace-pre-wrap/);
  assert.match(source, /MarkdownRoot-/);
  assert.match(source, /messageRecords/);
  assert.match(source, /lastMessageRole = lastMessage\?\.role/);
  assert.match(source, /conversationMessages\.length/);
});

