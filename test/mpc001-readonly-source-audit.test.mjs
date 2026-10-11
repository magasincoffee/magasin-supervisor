import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const read = (p) => fs.readFile(new URL("../" + p, import.meta.url), "utf8");
test("MPC-001 documents real read-only Control Center integration seams", async () => {
  const [audit, plan, server, ui, sot] = await Promise.all([
    read("docs/project-control/MPC-001_READ_ONLY_SOURCE_AUDIT_2026-10-11.md"),
    read("docs/project-control/MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md"),
    read("src/control-center/server.py"), read("src/control-center/web/app.js"),
    read("SOURCE_OF_TRUTH.md")
  ]);
  assert.match(plan, /MPC-002 is the sole next executable task/);
  assert.match(plan, /MPC-001 execution evidence/);
  assert.match(plan, /MPC-001 G0 source audit VERIFIED/);
  assert.match(plan, /a06690c81e00ab09e406021579f36e11022f3542/);
  assert.match(audit, /G0.*source audit VERIFIED/);
  assert.match(audit, /follow-up verification candidate/);
  for (const [text, pattern] of [
    [server, /class Handler\(BaseHTTPRequestHandler\):/],
    [server, /if p=="\/api\/overview":/],
    [server, /if route == "\/api\/supervisor\/project\/link":/],
    [server, /X-MAGASIN-CSRF/],
    [server, /HOST = "127\.0\.0\.1"/],
    [ui, /function currentPage\(/],
    [ui, /function openPage\(/],
    [ui, /\/api\/supervisor\/project\/check/],
    [sot, /P1 NEXT \/ SOURCE AND QA ONLY/],
    [sot, /AUTOSTART_DISABLED/],
  ]) assert.match(text, pattern);
  assert.match(audit, /Owner-vs-viewer authorization boundary/);
  assert.match(audit, /GET \/api\/projects/);
  assert.match(audit, /UNKNOWN\/CONFLICT/);
  assert.match(audit, /four.*required|Hosted required gates/i);
  assert.doesNotMatch(audit, /MPC-001\s+VERIFIED_DONE/);
});
