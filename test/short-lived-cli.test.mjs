import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

for (const file of ["dry-run-cli.mjs", "one-shot-cli.mjs"]) {
  test(`${file} terminates explicitly after short-lived CDP use`, async () => {
    const source = await fs.readFile(
      new URL(`../src/runtime/${file}`, import.meta.url),
      "utf8"
    );

    assert.match(source, /finally\s*\{[\s\S]*session\.disconnect\(\)/);
    assert.match(source, /process\.exit\(process\.exitCode \?\? 0\)/);
  });
}
