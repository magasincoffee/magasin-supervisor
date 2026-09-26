import test from "node:test";
import assert from "node:assert/strict";

import {
  captureAssistantTurnDigests,
  captureAssistantTurnAfterUserMarker,
  captureRecentConversationTurns,
  captureUserTurnDigests,
  digestCapturedResponse
} from "../src/ui/message-capture.mjs";

test("assistant continuity capture returns only deterministic digests to the runtime", async () => {
  const page = {
    async evaluate() {
      return [
        { role: "assistant", text: "older Brain response", turn: 1, chars: 20 },
        { role: "assistant", text: "latest Brain response", turn: 2, chars: 21 }
      ];
    }
  };

  const digests = await captureAssistantTurnDigests(page);
  assert.deepEqual(digests, [
    digestCapturedResponse("older Brain response"),
    digestCapturedResponse("latest Brain response")
  ]);
  assert.equal(digests.includes("older Brain response"), false);
  assert.equal(digests.includes("latest Brain response"), false);
});


test("Worker instruction continuity capture returns only deterministic user-turn digests", async () => {
  const page = {
    async evaluate() {
      return [
        { role: "user", text: "TASK-049/D instruction", turn: 1, chars: 22 },
        { role: "user", text: "TASK-049/E instruction", turn: 2, chars: 22 }
      ];
    }
  };

  const digests = await captureUserTurnDigests(page);
  assert.deepEqual(digests, [
    digestCapturedResponse("TASK-049/D instruction"),
    digestCapturedResponse("TASK-049/E instruction")
  ]);
  assert.equal(digests.includes("TASK-049/E instruction"), false);
});


test("recent conversation capture preserves role order and hashes bodies", async () => {
  const page = {
    async evaluate() {
      return [
        { role: "user", text: "Owner asks", turn: 10, chars: 10 },
        { role: "assistant", text: "progress update", turn: 11, chars: 15 },
        { role: "assistant", text: "final directive", turn: 12, chars: 15 }
      ];
    }
  };

  const turns = await captureRecentConversationTurns(page, { limit: 40 });
  assert.deepEqual(turns.map((item) => item.role), ["user", "assistant", "assistant"]);
  assert.equal(turns[0].digest, digestCapturedResponse("Owner asks"));
  assert.equal(turns[2].digest, digestCapturedResponse("final directive"));
});

test("capture layer includes the live ChatGPT modern DOM selectors", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/ui/message-capture.mjs", import.meta.url), "utf8")
  );

  assert.match(source, /text-size-chat\.whitespace-pre-wrap/);
  assert.match(source, /MarkdownRoot-/);
  assert.match(source, /data-message-author-role/);
  assert.match(source, /compareDocumentPosition/);
  assert.match(source, /modern-user/);
  assert.match(source, /modern-assistant/);
});

test("Work result capture ignores an old assistant reply before the current dispatch marker", async () => {
  const marker = "dispatch_id=dispatch-new";
  const page = {
    async evaluate() {
      return [
        { role: "user", text: "dispatch_id=dispatch-old\nold task", turn: 1, chars: 33 },
        { role: "assistant", text: "OLD TEST RESULT", turn: 2, chars: 15 },
        { role: "user", text: `${marker}\nnew task`, turn: 3, chars: 32 }
      ];
    }
  };

  const captured = await captureAssistantTurnAfterUserMarker(page, marker);
  assert.equal(captured, null);
});

test("Work result capture accepts only the assistant reply after the current dispatch marker", async () => {
  const marker = "dispatch_id=dispatch-new";
  const page = {
    async evaluate() {
      return [
        { role: "user", text: "dispatch_id=dispatch-old\nold task", turn: 1, chars: 33 },
        { role: "assistant", text: "OLD TEST RESULT", turn: 2, chars: 15 },
        { role: "user", text: `${marker}\nnew task`, turn: 3, chars: 32 },
        { role: "assistant", text: "NEW TEST RESULT", turn: 4, chars: 15 }
      ];
    }
  };

  const captured = await captureAssistantTurnAfterUserMarker(page, marker);
  assert.equal(captured.text, "NEW TEST RESULT");
  assert.equal(captured.turn, 4);
  assert.equal(captured.digest, digestCapturedResponse("NEW TEST RESULT"));
});

test("a later unrelated user turn breaks Work result correlation", async () => {
  const marker = "dispatch_id=dispatch-new";
  const page = {
    async evaluate() {
      return [
        { role: "user", text: `${marker}\nnew task`, turn: 1, chars: 32 },
        { role: "user", text: "manual Owner message", turn: 2, chars: 20 },
        { role: "assistant", text: "reply to Owner", turn: 3, chars: 14 }
      ];
    }
  };

  const captured = await captureAssistantTurnAfterUserMarker(page, marker);
  assert.equal(captured, null);
});

