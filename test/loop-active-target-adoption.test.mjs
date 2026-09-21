import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("loop adopts a usable active ChatGPT conversation before navigating to stale target", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/supervisor-loop-cli.mjs", import.meta.url),
    "utf8"
  );

  const adoptIndex = source.indexOf('target: "ACTIVE_CONVERSATION_PATH"');
  const gotoIndex = source.indexOf("const response = await page.goto(wanted");

  assert.ok(adoptIndex >= 0, "active-conversation adoption branch must exist");
  assert.ok(gotoIndex >= 0, "target navigation branch must exist");
  assert.ok(adoptIndex < gotoIndex, "adoption must run before stale-target navigation");
  assert.match(source, /target = activeTarget/);
  assert.match(source, /await writeTarget\(targetPath, target\)/);
  assert.match(source, /recovery\.noteConversationAdopted\(\)/);
  assert.match(source, /!activeSnapshot\.conversationMissing/);
  assert.match(source, /!activeSnapshot\.conversationFull/);
});
