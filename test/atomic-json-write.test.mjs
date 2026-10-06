import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  atomicJsonWrite,
  pendingAtomicJsonWriteCount,
  renameAtomicSnapshotWithRetry
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

test("Windows atomic rename retries transient destination sharing failures without deleting state", async () => {
  const calls = [];
  const sleeps = [];
  const errors = ["EPERM", "EACCES"];

  await renameAtomicSnapshotWithRetry("temp.json", "state.json", {
    platform: "win32",
    rename: async (source, destination) => {
      calls.push([source, destination]);
      const code = errors.shift();
      if (code) {
        const error = new Error(code);
        error.code = code;
        throw error;
      }
    },
    sleep: async (ms) => { sleeps.push(ms); },
    maxAttempts: 5
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [25, 50]);
  assert.deepEqual(calls[0], ["temp.json", "state.json"]);
});

test("Windows atomic rename default retry window survives multi-second transient locks", async () => {
  let attempts = 0;
  const sleeps = [];

  await renameAtomicSnapshotWithRetry("temp.json", "state.json", {
    platform: "win32",
    rename: async () => {
      attempts += 1;
      if (attempts <= 10) {
        const error = new Error("locked");
        error.code = "EPERM";
        throw error;
      }
    },
    sleep: async (ms) => { sleeps.push(ms); }
  });

  assert.equal(attempts, 11);
  assert.equal(sleeps.length, 10);
  assert.ok(sleeps.reduce((sum, value) => sum + value, 0) >= 2_700);
});

test("atomic rename retry remains bounded and Windows-only", async () => {
  let windowsAttempts = 0;
  await assert.rejects(
    renameAtomicSnapshotWithRetry("temp.json", "state.json", {
      platform: "win32",
      rename: async () => {
        windowsAttempts += 1;
        const error = new Error("locked");
        error.code = "EPERM";
        throw error;
      },
      sleep: async () => {},
      maxAttempts: 3
    }),
    (error) => error?.code === "EPERM"
  );
  assert.equal(windowsAttempts, 3);

  let linuxAttempts = 0;
  await assert.rejects(
    renameAtomicSnapshotWithRetry("temp.json", "state.json", {
      platform: "linux",
      rename: async () => {
        linuxAttempts += 1;
        const error = new Error("locked");
        error.code = "EPERM";
        throw error;
      },
      sleep: async () => {}
    }),
    (error) => error?.code === "EPERM"
  );
  assert.equal(linuxAttempts, 1);
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
  assert.match(source, /TRANSIENT_WINDOWS_RENAME_CODES/);
  assert.match(source, /renameAtomicSnapshotWithRetry\(temp, filePath\)/);
  assert.doesNotMatch(source, /rm\(filePath/);
});

test("Three-Lane runtime delegates all JSON state commits to the serialized writer", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /import \{ atomicJsonWrite \} from "\.\/atomic-json-write\.mjs"/);
  assert.doesNotMatch(source, /const temp = `\$\{filePath\}\.tmp`/);
});
