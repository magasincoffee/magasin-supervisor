import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("continuous loop bases retry reset on the current probe", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/supervisor-loop-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(source, /result\.probe/);
  assert.match(source, /probe\.classification\.observation/);
  assert.match(source, /TRANSIENT_ERROR/);
});


test("continuous loop persists classified connection cause without raw error text", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/supervisor-loop-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /errorCause: event\.errorCause \|\| undefined/);
  assert.doesNotMatch(source, /errorMessage: event\.errorMessage/);
});
