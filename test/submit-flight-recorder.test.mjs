import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beginSubmitFlightRecording } from "../src/ui/submit-flight-recorder.mjs";

test("submit flight recorder preserves failure evidence without raw instruction text", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-submit-flight-"));
  const instruction = "sensitive test instruction";
  let traceStarts = 0;
  let traceStops = 0;

  const tracing = {
    async start() { traceStarts += 1; },
    async stop({ path: tracePath }) {
      traceStops += 1;
      await fs.writeFile(tracePath, "trace", "utf8");
    }
  };
  const page = {
    isClosed() { return false; },
    context() { return { tracing }; },
    async evaluate() {
      return {
        url: "https://chatgpt.com/c/test",
        title: "ChatGPT",
        visibility: "visible",
        hasFocus: true,
        activeElement: null,
        composer: null,
        composerText: instruction,
        composerForm: null,
        controls: [],
        target: null,
        elementAtTargetCenter: null,
        userTurnCount: 0
      };
    },
    async screenshot({ path: screenshotPath }) {
      await fs.writeFile(screenshotPath, "png", "utf8");
    }
  };

  const recorder = await beginSubmitFlightRecording(page, instruction, {
    env: {
      MAGASIN_SUBMIT_DEBUG: "all",
      MAGASIN_SUBMIT_DEBUG_DIR: root
    }
  });
  await recorder.capture("before-submit", {
    selector: 'button[data-testid="send-button"]',
    scope: "composer-form",
    method: "direct-control"
  });
  const kept = await recorder.finish({
    success: false,
    result: {
      executed: false,
      rejection_class: "SEND_NOT_ACTUATED",
      send_method: "direct-control",
      submit_evidence: "instruction-still-present"
    }
  });

  assert.ok(kept);
  assert.equal(traceStarts, 1);
  assert.equal(traceStops, 1);

  const latest = JSON.parse(
    await fs.readFile(path.join(root, "latest.json"), "utf8")
  );
  assert.equal(latest.success, false);
  assert.equal(latest.result.rejection_class, "SEND_NOT_ACTUATED");
  assert.equal(latest.instruction_chars, instruction.length);
  assert.notEqual(latest.instruction_digest, instruction);

  const files = await fs.readdir(kept);
  const textual = files.filter((name) => /\.(json|ndjson)$/.test(name));
  for (const name of textual) {
    const body = await fs.readFile(path.join(kept, name), "utf8");
    assert.doesNotMatch(body, new RegExp(instruction));
  }

  await fs.rm(root, { recursive: true, force: true });
});

test("default failure-only recorder deletes successful run artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-submit-flight-"));
  const tracing = {
    async start() {},
    async stop({ path: tracePath }) {
      await fs.writeFile(tracePath, "trace", "utf8");
    }
  };
  const page = {
    isClosed() { return false; },
    context() { return { tracing }; },
    async evaluate() {
      return {
        url: "https://chatgpt.com/c/test",
        title: "ChatGPT",
        visibility: "visible",
        hasFocus: true,
        activeElement: null,
        composer: null,
        composerText: "",
        composerForm: null,
        controls: [],
        target: null,
        elementAtTargetCenter: null,
        userTurnCount: 1
      };
    },
    async screenshot({ path: screenshotPath }) {
      await fs.writeFile(screenshotPath, "png", "utf8");
    }
  };

  const recorder = await beginSubmitFlightRecording(page, "ok", {
    env: {
      MAGASIN_SUBMIT_DEBUG: "failures",
      MAGASIN_SUBMIT_DEBUG_DIR: root
    }
  });
  await recorder.capture("send-confirmed");
  const kept = await recorder.finish({
    success: true,
    result: {
      executed: true,
      user_turn_evidence: "matching-user-turn-observed"
    }
  });

  assert.equal(kept, null);
  const entries = await fs.readdir(root);
  assert.deepEqual(entries, []);
  await fs.rm(root, { recursive: true, force: true });
});
