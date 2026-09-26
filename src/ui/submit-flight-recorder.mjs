import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { resolveStateRoot } from "../state-root.mjs";

function normalizeMode(value = process.env.MAGASIN_SUBMIT_DEBUG) {
  const raw = String(value ?? "failures").trim().toLowerCase();
  if (["0", "false", "off", "disabled"].includes(raw)) return "off";
  if (["1", "true", "on", "all", "keep"].includes(raw)) return "all";
  return "failures";
}

function digestText(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function safeStage(value) {
  return String(value || "stage").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80);
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function diagnosticsRoot(env = process.env) {
  const explicit = String(env.MAGASIN_SUBMIT_DEBUG_DIR || "").trim();
  if (explicit) return path.resolve(explicit);
  return path.join(
    resolveStateRoot({ env, compatibility: "legacy-preserve" }),
    "diagnostics",
    "submit"
  );
}

async function collectDomState(page, target = {}) {
  const raw = await page.evaluate(({ targetSelector, targetScope }) => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) !== 0 &&
        box.width > 0 &&
        box.height > 0;
    };
    const describe = (el) => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return {
        tag: String(el.tagName || ""),
        id: String(el.id || ""),
        role: String(el.getAttribute?.("role") || ""),
        type: String(el.getAttribute?.("type") || ""),
        testid: String(el.getAttribute?.("data-testid") || ""),
        aria: String(el.getAttribute?.("aria-label") || "").slice(0, 160),
        title: String(el.getAttribute?.("title") || "").slice(0, 160),
        contenteditable: String(el.getAttribute?.("contenteditable") || ""),
        disabled: Boolean(el.disabled) || el.getAttribute?.("aria-disabled") === "true",
        visible: visible(el),
        cls: String(el.className || "").replace(/[\r\n]+/g, " ").slice(0, 240),
        text: String(el.innerText || el.textContent || "").trim().slice(0, 160),
        rect: {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height)
        }
      };
    };
    const composer = document.querySelector(
      '#prompt-textarea, div[contenteditable="true"][data-lexical-editor="true"], [contenteditable][role="textbox"], textarea, [contenteditable]'
    );
    const composerText = composer
      ? String(
          composer instanceof HTMLInputElement || composer instanceof HTMLTextAreaElement
            ? composer.value
            : composer.innerText || composer.textContent || ""
        )
      : "";
    const composerForm = composer?.closest("form") || null;
    const controlsRoot = composerForm || document;
    const controls = Array.from(controlsRoot.querySelectorAll("button,[role='button']"))
      .filter(visible)
      .slice(-60)
      .map(describe);

    let targetNode = null;
    if (targetSelector) {
      const css = String(targetSelector).replace(/:visible/g, "");
      try {
        const root = targetScope === "composer-form" && composerForm
          ? composerForm
          : document;
        targetNode = root.querySelector(css);
      } catch {}
    }
    const targetDescription = describe(targetNode);
    let elementAtCenter = null;
    if (targetNode) {
      const box = targetNode.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      elementAtCenter = describe(document.elementFromPoint(x, y));
    }

    const userTurns = Array.from(
      document.querySelectorAll('[data-message-author-role="user"]')
    );
    return {
      url: location.href,
      title: document.title,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      activeElement: describe(document.activeElement),
      composer: describe(composer),
      composerText,
      composerForm: describe(composerForm),
      controls,
      target: targetDescription,
      elementAtTargetCenter: elementAtCenter,
      userTurnCount: userTurns.length
    };
  }, {
    targetSelector: target?.selector || null,
    targetScope: target?.scope || null
  });

  const composerText = String(raw?.composerText || "");
  return {
    ...raw,
    composerText: undefined,
    composerTextLength: composerText.length,
    composerTextDigest: digestText(composerText),
    targetHint: {
      selector: target?.selector || null,
      scope: target?.scope || null,
      method: target?.method || null
    }
  };
}

class DisabledRecorder {
  constructor() {
    this.enabled = false;
    this.dir = null;
  }
  async capture() {}
  async finish() { return null; }
}

class SubmitFlightRecorder {
  constructor({ page, instruction, mode, root, dir }) {
    this.enabled = true;
    this.page = page;
    this.mode = mode;
    this.root = root;
    this.dir = dir;
    this.instructionChars = String(instruction || "").length;
    this.instructionDigest = digestText(instruction);
    this.sequence = 0;
    this.traceStarted = false;
    this.traceError = null;
  }

  async start() {
    await fs.mkdir(this.dir, { recursive: true });
    const tracing = this.page?.context?.()?.tracing;
    if (tracing && typeof tracing.start === "function") {
      try {
        await tracing.start({
          screenshots: true,
          snapshots: true,
          sources: false
        });
        this.traceStarted = true;
      } catch (error) {
        this.traceError = String(error?.message || error).slice(0, 500);
      }
    }
    await writeJson(path.join(this.dir, "meta.json"), {
      schema_version: 1,
      started_at: new Date().toISOString(),
      mode: this.mode,
      pid: process.pid,
      instruction_chars: this.instructionChars,
      instruction_digest: this.instructionDigest,
      trace_started: this.traceStarted,
      trace_error: this.traceError
    });
  }

  async capture(stage, target = {}) {
    if (!this.enabled || !this.page || this.page.isClosed?.()) return null;
    this.sequence += 1;
    const prefix = `${String(this.sequence).padStart(2, "0")}-${safeStage(stage)}`;
    const payload = {
      schema_version: 1,
      captured_at: new Date().toISOString(),
      stage: String(stage || ""),
      instruction_chars: this.instructionChars,
      instruction_digest: this.instructionDigest,
      ...(await collectDomState(this.page, target))
    };
    await writeJson(path.join(this.dir, `${prefix}.json`), payload)
      .catch(() => {});
    if (typeof this.page.screenshot === "function") {
      await this.page.screenshot({
        path: path.join(this.dir, `${prefix}.png`),
        fullPage: false
      }).catch(() => {});
    }
    return payload;
  }

  async finish({ success, result = null, error = null } = {}) {
    if (!this.enabled) return null;

    if (this.traceStarted) {
      try {
        await this.page.context().tracing.stop({
          path: path.join(this.dir, "trace.zip")
        });
      } catch (traceError) {
        this.traceError = String(traceError?.message || traceError).slice(0, 500);
      }
      this.traceStarted = false;
    }

    const summary = {
      schema_version: 1,
      finished_at: new Date().toISOString(),
      success: Boolean(success),
      mode: this.mode,
      instruction_chars: this.instructionChars,
      instruction_digest: this.instructionDigest,
      result: result ? {
        executed: Boolean(result.executed),
        rejection_class: result.rejection_class || null,
        input_method: result.input_method || null,
        send_method: result.send_method || null,
        send_selector: result.send_selector || null,
        send_scope: result.send_scope || null,
        primary_submit_evidence: result.primary_submit_evidence || null,
        submit_evidence: result.submit_evidence || null,
        user_turn_evidence: result.user_turn_evidence || null,
        reason: result.reason || null
      } : null,
      error: error ? {
        name: error?.name || "Error",
        message: String(error?.message || error).slice(0, 1000)
      } : null,
      trace_error: this.traceError
    };
    await writeJson(path.join(this.dir, "summary.json"), summary).catch(() => {});

    const keep = this.mode === "all" || !success;
    if (!keep) {
      await fs.rm(this.dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    await fs.mkdir(this.root, { recursive: true }).catch(() => {});
    const pointer = {
      ...summary,
      diagnostic_dir: this.dir
    };
    await writeJson(path.join(this.root, "latest.json"), pointer).catch(() => {});
    await fs.appendFile(
      path.join(this.root, "incidents.ndjson"),
      JSON.stringify(pointer) + "\n",
      "utf8"
    ).catch(() => {});
    return this.dir;
  }
}

export async function beginSubmitFlightRecording(
  page,
  instruction,
  { env = process.env } = {}
) {
  const mode = normalizeMode(env.MAGASIN_SUBMIT_DEBUG);
  if (mode === "off") return new DisabledRecorder();

  const root = diagnosticsRoot(env);
  const nonce = crypto.randomBytes(3).toString("hex");
  const dir = path.join(root, `${timestampId()}-${process.pid}-${nonce}`);
  const recorder = new SubmitFlightRecorder({
    page,
    instruction,
    mode,
    root,
    dir
  });
  try {
    await recorder.start();
    return recorder;
  } catch {
    return new DisabledRecorder();
  }
}
