import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { OBSERVATIONS } from "../src/decision.mjs";
import { UI_STATES, classifyUiSnapshot } from "../src/ui/classifier.mjs";
import {
  SEND_REJECTION_CLASSES,
  classifyComposerSendRejection
} from "../src/ui/actions.mjs";
import { matchesRateLimitText } from "../src/ui/snapshot.mjs";

async function source(path) {
  return fs.readFile(new URL(path, import.meta.url), "utf8");
}

const baseSnapshot = {
  composerReady: true,
  assistantMessageCount: 1,
  userMessageCount: 1,
  conversationPath: true,
  loginRequired: false,
  hasCaptcha: false,
  responseRunning: false,
  hasNetworkError: false,
  hasTransientError: false,
  hasRetryControl: false,
  rateLimited: false
};

test("P2 rate-limit surfaces are detected in English and Vietnamese", () => {
  assert.equal(
    matchesRateLimitText("Too many requests. You are sending requests too quickly."),
    true
  );
  assert.equal(
    matchesRateLimitText("Quá nhiều yêu cầu. Bạn đang gửi yêu cầu quá nhanh. Vui lòng đợi vài phút."),
    true
  );
});

test("P2 rate-limit is a distinct non-semantic bounded transient class", () => {
  const classified = classifyUiSnapshot({
    ...baseSnapshot,
    rateLimited: true
  });
  assert.equal(classified.uiState, UI_STATES.RATE_LIMITED);
  assert.equal(classified.observation, OBSERVATIONS.TRANSIENT_ERROR);
  assert.equal(
    classifyComposerSendRejection({ rateLimited: true }),
    SEND_REJECTION_CLASSES.RATE_LIMITED
  );
});

test("P2 AUTO create remains exactly-once after ambiguous create-before-persist restart", async () => {
  const runtime = await source("../src/runtime/three-lane-cli.mjs");
  const start = runtime.indexOf("async function dispatchWork");
  const end = runtime.indexOf("async function reconcileRelayInflight", start);
  assert.ok(start >= 0 && end > start);
  const work = runtime.slice(start, end);
  const ambiguous = work.indexOf("AUTO_WORK_CREATE_RESTART_AMBIGUOUS");
  const create = work.indexOf("created = await createBlankWorkTarget");
  assert.ok(ambiguous >= 0 && create > ambiguous);
  assert.match(
    work,
    /else if \(rollover\.reason === "NO_WORK_TARGET"\)[\s\S]*AUTO_WORK_CREATE_AMBIGUOUS[\s\S]*return;/
  );
});

test("P2 live workflow is explicit-trigger-only and never cancels into a burst replacement", async () => {
  const workflow = await source("../.github/workflows/supervisor-p2-live-acceptance-temp.yml");
  assert.match(workflow, /\.github\/p2-live-request\.txt/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.doesNotMatch(
    workflow,
    /src\/runtime\/three-lane-cli\.mjs|supervisor-p2-live-isolated\.ps1\s*$/
  );
  assert.match(workflow, /P2_LIVE_MUTATION_PACING_MS:\s*"5000"/);
  assert.match(workflow, /P2_LIVE_RATE_LIMIT_COOLDOWN_MINUTES:\s*"5"/);
});

test("P2 launcher forbids a second browser/profile attempt inside the same live run", async () => {
  const launcher = await source("../.github/scripts/supervisor-p2-live-launcher.ps1");
  assert.match(launcher, /LIVE_P2_SECOND_BROWSER_ATTEMPT_BLOCKED=True/);
  assert.doesNotMatch(launcher, /supervisor-p2-live-runner-isolated\.ps1/);
});

test("P2 live harness emits sanitized rate-limit marker and persists multi-minute cooldown", async () => {
  const harness = await source("../.github/scripts/supervisor-p2-live-isolated.ps1");
  assert.match(harness, /LIVE_P2_RATE_LIMIT_DETECTED=True/);
  assert.match(harness, /P2_LIVE_RATE_LIMITED_NON_SEMANTIC/);
  assert.match(harness, /P2_LIVE_RATE_LIMIT_COOLDOWN_ACTIVE/);
  assert.match(harness, /\[Math\]::Max\(5,\$parsedCooldown\)/);
  assert.match(harness, /"--poll-ms","5000"/);
});

test("P2 fixture reuses at most one recent conversation and never blind-retries create", async () => {
  const fixture = await source("../.github/scripts/supervisor-p2-live-brain-fixture.mjs");
  assert.match(fixture, /listRecentConversationUrls\(page, \{ limit: 1 \}\)/);
  assert.doesNotMatch(fixture, /for \(const url of recentUrls\)/);
  assert.match(fixture, /P2_FIXTURE_CACHE_FILE/);
  assert.match(fixture, /LIVE_P2_FIXTURE_CACHE_REUSED=True/);
  assert.match(fixture, /LIVE_P2_FIXTURE_RECENT_SINGLE_REUSED=True/);
  assert.match(fixture, /mutationPacingMs/);
  assert.match(fixture, /LIVE_P2_RATE_LIMIT_DETECTED=True/);
});


test("P2 AUTO Work bootstrap waits for stable assistant completion before canonical reload", async () => {
  const runtime = await source("../src/runtime/three-lane-cli.mjs");
  const start = runtime.indexOf("async function primeBlankWorkConversation");
  const end = runtime.indexOf("async function createBlankWorkTarget", start);
  assert.ok(start >= 0 && end > start);
  const bootstrap = runtime.slice(start, end);

  const send = bootstrap.indexOf("sendComposerInstruction");
  const response = bootstrap.indexOf("AUTO_WORK_BOOTSTRAP_RESPONSE_NOT_CONFIRMED");
  const reload = bootstrap.indexOf("page.goto(canonicalUrl");
  assert.ok(send >= 0);
  assert.ok(response > send);
  assert.ok(reload > response);
  assert.match(bootstrap, /MAGASIN_WORK_READY/);
  assert.match(bootstrap, /captureCompletedAssistantTurn/);
  assert.match(bootstrap, /OBSERVATIONS\.RESPONSE_COMPLETE/);
  assert.match(bootstrap, /captured\?\.text\?\.trim\(\)/);
  assert.match(bootstrap, /AUTO_WORK_BOOTSTRAP_CANONICAL_RELOAD_NOT_CONFIRMED/);
});

test("P2 sanitized diagnostics read safe-log snake_case error names and classify bootstrap failures", async () => {
  const harness = await source("../.github/scripts/supervisor-p2-live-isolated.ps1");
  assert.match(harness, /Get-OptionalPropertyValue \$event "error_name"/);
  assert.match(harness, /BOOTSTRAP_RESPONSE_NOT_CONFIRMED/);
  assert.match(harness, /BOOTSTRAP_CANONICAL_RELOAD_NOT_CONFIRMED/);
  assert.match(harness, /TARGET_CREATE_NOT_CONFIRMED/);
});
