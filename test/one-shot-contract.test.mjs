import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("one-shot runtime keeps explicit execute gate", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/one-shot-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /execute: false/);
  assert.match(source, /--execute/);
  assert.match(source, /dryRun: !args\.execute/);
  assert.match(source, /STOP_WAIT_USER/);
  assert.match(source, /STOP_DONE/);
});

test("one-shot runtime never embeds credentials or session data", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/one-shot-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(source, /password/i);
  assert.doesNotMatch(source, /cookie/i);
  assert.doesNotMatch(source, /token/i);
  assert.doesNotMatch(source, /storageState/);
});
