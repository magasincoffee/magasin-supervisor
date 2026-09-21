import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("long-running Supervisor adopts a newly created ChatGPT conversation after send", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/supervisor-loop-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /execution\.target === "COMPOSER_SEND"/);
  assert.match(source, /targetFromUrl\(page\.url\(\)\)/);
  assert.match(source, /writeTarget\(targetPath, target\)/);
  assert.match(source, /TARGET_ADOPTED/);
  assert.match(source, /noteConversationAdopted\(\)/);
});

test("fresh-chat rollover atomically persists the new target instead of revisiting the old chat", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/supervisor-loop-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /CONVERSATION_ROLLOVER/);
  assert.match(source, /await writeTarget\(targetPath, newTarget\)/);
  assert.match(source, /page\.waitForURL/);
  assert.match(source, /ROLLOVER_CONVERSATION_FULL/);
  assert.doesNotMatch(source, /ROLLOVER_TARGET_MISSING/);
  assert.match(source, /rollover denied without conversationFull evidence/);
});
