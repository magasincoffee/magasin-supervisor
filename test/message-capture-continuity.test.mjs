import test from "node:test";
import assert from "node:assert/strict";

import {
  captureAssistantTurnDigests,
  captureRecentConversationTurns,
  captureUserTurnDigests,
  digestCapturedResponse
} from "../src/ui/message-capture.mjs";

test("assistant continuity capture returns only deterministic digests to the runtime", async () => {
  const page = {
    async evaluate() {
      return ["older Brain response", "latest Brain response"];
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
      return ["WORK-CAP-D instruction", "WORK-CAP-E instruction"];
    }
  };

  const digests = await captureUserTurnDigests(page);
  assert.deepEqual(digests, [
    digestCapturedResponse("WORK-CAP-D instruction"),
    digestCapturedResponse("WORK-CAP-E instruction")
  ]);
  assert.equal(digests.includes("WORK-CAP-E instruction"), false);
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
