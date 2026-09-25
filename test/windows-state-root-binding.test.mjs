import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const read = (name) =>
  fs.readFile(new URL(`../windows/${name}`, import.meta.url), "utf8");

test("PowerShell state-root resolver honors persisted User/Machine binding before legacy fallback", async () => {
  const source = await read("state-root.ps1");

  assert.match(source, /Get-PersistedSupervisorStateRoot/);
  assert.match(source, /foreach \(\$target in @\('User','Machine'\)\)/);
  assert.match(source, /\[EnvironmentVariableTarget\]::\$target/);
  assert.match(source, /GetEnvironmentVariable/);
  assert.match(source, /Set-SupervisorStateRootBinding/);
  assert.match(source, /SetEnvironmentVariable/);
});

test("runtime launch surfaces propagate the resolved canonical state root", async () => {
  const [panel, start, bootstrap, install] = await Promise.all([
    read("control-panel.ps1"),
    read("start-supervisor.ps1"),
    read("autostart-bootstrap.ps1"),
    read("install-supervisor.ps1")
  ]);

  for (const source of [panel, start, bootstrap]) {
    assert.match(source, /\$env:SUPERVISOR_STATE_ROOT = \$root/);
  }
  assert.match(install, /Set-SupervisorStateRootBinding -Root \$root/);
});
