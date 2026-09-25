import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

const writeQueues = new Map();

async function writeAtomicJsonSnapshot(filePath, serialized) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // Keep the temp file in the same directory so the final rename stays on the
  // same filesystem. Every write gets its own name; no concurrent writer can
  // steal another writer's .tmp path.
  const temp = `${filePath}.tmp.${process.pid}.${randomUUID()}`;

  try {
    await fs.writeFile(temp, serialized, {
      encoding: "utf8",
      flag: "wx"
    });
    await fs.rename(temp, filePath);
  } finally {
    // If rename succeeded the temp path is already gone. If anything failed,
    // remove only this writer's private temp file.
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * Serialize atomic JSON commits per destination path.
 *
 * The JSON snapshot is captured when the function is called, not later when a
 * queued write eventually runs. This prevents later in-memory mutations from
 * changing the meaning/order of an earlier persisted transition.
 */
export async function atomicJsonWrite(filePath, value) {
  const resolved = path.resolve(filePath);
  const serialized = JSON.stringify(value, null, 2) + "\n";

  const previous = writeQueues.get(resolved) || Promise.resolve();
  const operation = previous
    .catch(() => {
      // A failed earlier write must not permanently poison the queue.
    })
    .then(() => writeAtomicJsonSnapshot(resolved, serialized));

  writeQueues.set(resolved, operation);

  try {
    await operation;
  } finally {
    if (writeQueues.get(resolved) === operation) {
      writeQueues.delete(resolved);
    }
  }
}

export function pendingAtomicJsonWriteCount() {
  return writeQueues.size;
}
