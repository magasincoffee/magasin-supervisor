import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const workflow = new URL("../.github/workflows/magasin-local-dispatch-receipts.yml", import.meta.url);
const script = new URL("../.github/scripts/sc013-local-30m-tick.py", import.meta.url);
const sot = new URL("../SOURCE_OF_TRUTH.md", import.meta.url);

test("SC-013 local monitoring is twice hourly without pretending ChatGPT runs", async () => {
  const w = await fs.readFile(workflow,"utf8");
  const p = await fs.readFile(script,"utf8");
  assert.match(w, /17,47 \* \* \* \*/);
  assert.match(w, /sc013-local-30m-tick\.py/);
  assert.match(w, /github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/);
  assert.match(p, /MAGASIN_LOCAL_30M_TICK_V1/);
  assert.match(p, /sc013-local-30m\.json/);
  assert.match(p, /sc013-chatgpt-monitor\.json/);
  assert.match(p, /source_issue":346|source_issue", 346/);
  assert.ok(p.includes('item.get("executor") != "chatgpt_automation"'));
});
test("SC-013 local tick executes ONLY qualified work and preserves Owner shutdown", async () => {
  const s=await fs.readFile(script,"utf8");
  const authority=await fs.readFile(sot,"utf8");
  assert.match(s, /dispatch_gateway\.py/);
  assert.match(s, /coordinator\.py/);
  assert.match(s, /NOT_QUALIFIED_NO_SOT_ADAPTER/);
  assert.match(s, /WRONG_MACHINE_FAIL_CLOSED/);
  assert.match(s, /ONLY_ACTIONS_OR_DRY_RUN/);
  assert.doesNotMatch(s,/control_adapter\.perform|markExactOnceDelivered|sendProtocolMessage|Start-Process|Stop-Process|taskkill/);
  assert.match(authority,/SC-013 local thirty-minute monitoring and qualified work/);
  assert.match(authority,/Issue \*\*#346\*\*/);
  assert.match(authority,/Issue \*\*#347\*\*/);
});
