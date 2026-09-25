import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  atomicJsonWrite,
  pendingAtomicJsonWriteCount
} from "../src/runtime/atomic-json-write.mjs";

test("atomicJsonWrite serializes concurrent writes and leaves the last snapshot intact", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-atomic-json-"));
  const target = path.join(dir, "lane-registry.json");

  try {
    const writes = [];
    for (let i = 0; i < 100; i += 1) {
      writes.push(atomicJsonWrite(target, {
        sequence: i,
        payload: "x".repeat(2048)
      }));
    }

    await Promise.all(writes);

    const parsed = JSON.parse(await fs.readFile(target, "utf8"));
    assert.equal(parsed.sequence, 99);
    assert.equal(pendingAtomicJsonWriteCount(), 0);

    const names = await fs.readdir(dir);
    assert.deepEqual(
      names.filter((name) => name.startsWith("lane-registry.json.tmp.")),
      []
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("atomicJsonWrite uses per-write private temp names rather than a shared .tmp path", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/atomic-json-write.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /randomUUID\(\)/);
  assert.match(source, /\.tmp\.\$\{process\.pid\}\.\$\{randomUUID\(\)\}/);
  assert.doesNotMatch(source, /const temp = `\$\{filePath\}\.tmp`;/);
  assert.match(source, /writeQueues/);
});

test("Three-Lane runtime delegates all JSON state commits to the serialized writer", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /import \{ atomicJsonWrite \} from "\.\/atomic-json-write\.mjs"/);
  assert.doesNotMatch(source, /const temp = `\$\{filePath\}\.tmp`/);
  assert.match(source, /SUPERVISOR_RUNTIME_VERSION = "2026-09-25\.61"/);
});
