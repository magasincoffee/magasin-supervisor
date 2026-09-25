import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const panelUrl = new URL("../windows/control-panel.ps1", import.meta.url);
const panelPath = fileURLToPath(panelUrl);

async function panelSource() {
  return fs.readFile(panelUrl, "utf8");
}

test("Control Panel viewport is monitor-aware and no longer locked to 1240x930", async () => {
  const source = await panelSource();

  assert.match(source, /function Get-ControlPanelViewportLayout\(\[Drawing\.Rectangle\]\$WorkingArea\)/);
  assert.match(source, /Screen\]::FromPoint\(\[Windows\.Forms\.Cursor\]::Position\)/);
  assert.match(source, /\$form\.Size = \$viewportLayout\.InitialSize/);
  assert.match(source, /\$form\.MinimumSize = \$viewportLayout\.MinimumSize/);
  assert.match(source, /\$form\.Location = \$viewportLayout\.Location/);
  assert.doesNotMatch(source, /\$form\.MinimumSize = New-Object Drawing\.Size\(1240, 930\)/);
});

test("Control Panel uses a scrollable logical canvas that contains all three lane cards", async () => {
  const source = await panelSource();

  assert.match(source, /\$scrollHost\.Dock = \[Windows\.Forms\.DockStyle\]::Fill/);
  assert.match(source, /\$scrollHost\.AutoScroll = \$true/);
  assert.match(source, /\$scrollHost\.AutoScrollMinSize = \$viewportLayout\.LogicalCanvasSize/);
  assert.match(source, /New-Object Drawing\.Size\(1215, 1510\)/);
  assert.match(source, /\$cardY = @\(244, 530, 816\)/);
  assert.match(source, /timeline_bottom = 1484/);
  assert.match(source, /critical_controls_scroll_reachable/);
  assert.match(source, /for \(\$i = 0; \$i -lt 3; \$i\+\+\)/);
  assert.match(source, /\$content\.Controls\.Add\(\$panel\)/);
});

test("viewport contract stays usable for 1080p, 900p and 768p working heights", async () => {
  const source = await panelSource();

  const desired = source.match(/\$desiredWindow = New-Object Drawing\.Size\((\d+), (\d+)\)/);
  const canvas = source.match(/\$logicalCanvas = New-Object Drawing\.Size\((\d+), (\d+)\)/);
  assert.ok(desired);
  assert.ok(canvas);

  const desiredWidth = Number(desired[1]);
  const desiredHeight = Number(desired[2]);
  const canvasWidth = Number(canvas[1]);
  const canvasHeight = Number(canvas[2]);

  function layout(width, height) {
    const initialWidth = Math.min(desiredWidth, Math.max(320, width));
    const initialHeight = Math.min(desiredHeight, Math.max(320, height));
    let minimumWidth = Math.min(900, Math.max(640, width - 24));
    let minimumHeight = Math.min(600, Math.max(420, height - 24));
    minimumWidth = Math.min(minimumWidth, initialWidth);
    minimumHeight = Math.min(minimumHeight, initialHeight);
    return { initialWidth, initialHeight, minimumWidth, minimumHeight };
  }

  for (const [width, height] of [
    [1920, 1040],
    [1600, 860],
    [1366, 728]
  ]) {
    const result = layout(width, height);
    assert.ok(result.initialWidth <= width);
    assert.ok(result.initialHeight <= height);
    assert.ok(result.minimumWidth <= result.initialWidth);
    assert.ok(result.minimumHeight <= result.initialHeight);
  }

  const low = layout(1366, 728);
  assert.ok(low.initialHeight < canvasHeight, "low viewport must scroll vertically");
  assert.ok(low.initialWidth >= canvasWidth, "1366-wide viewport should not require horizontal scrolling");
});

test("DPI scaling contract is explicit and scrolling remains available", async () => {
  const source = await panelSource();

  assert.match(source, /\$form\.AutoScaleMode = \[Windows\.Forms\.AutoScaleMode\]::Dpi/);
  assert.match(source, /\$form\.AutoScaleDimensions = New-Object Drawing\.SizeF\(96, 96\)/);
  assert.match(source, /\$scrollHost\.AutoScroll = \$true/);
  assert.doesNotMatch(source, /\$form\.FormBorderStyle\s*=\s*['"]Fixed/);
  assert.doesNotMatch(source, /\$form\.MinimizeBox\s*=\s*\$false/);
  assert.doesNotMatch(source, /\$form\.MaximizeBox\s*=\s*\$false/);
});

test("all lane START and STOP controls remain reachable content and preserve handlers", async () => {
  const source = await panelSource();

  assert.match(source, /\$startButton\.Text = '▶  BẮT ĐẦU LUỒNG'/);
  assert.match(source, /\$stopButton\.Text = '■  DỪNG LUỒNG'/);
  assert.match(source, /\$panel\.Controls\.Add\(\$startButton\)/);
  assert.match(source, /\$panel\.Controls\.Add\(\$stopButton\)/);
  assert.match(source, /Stop = \$stopButton/);
  assert.match(source, /\$stopButton\.Tag = \$currentLaneId/);

  assert.match(
    source,
    /\$startButton\.Add_Click\(\{[\s\S]*?Save-Lane \$id \$ui\.Project\.Text \$brainUrl \$true[\s\S]*?\}\)/
  );
  assert.match(
    source,
    /\$stopButton\.Add_Click\(\{[\s\S]*?Save-Lane \$id \$ui\.Project\.Text \$ui\.Brain\.Text \$false[\s\S]*?\}\)/
  );
});

test("viewport patch preserves lifecycle truth, Owner STOP and refresh timer semantics", async () => {
  const source = await panelSource();

  assert.match(source, /Get-LifecycleOwnerStopState -Root \$root/);
  assert.match(source, /Get-LifecycleProcessTruth -Root \$root/);
  assert.match(source, /if \(\$enabledLaneCount -gt 0 -and -not \$ownerStop\.blocked -and -not \$processTruth\.healthy\)/);
  assert.match(source, /\$runtimeStartButton\.Enabled = \[bool\]\(\$enabledLaneCount -gt 0 -and \$ownerStop\.blocked\)/);
  assert.match(source, /\$timer\.Interval = 2000/);
  assert.match(source, /\$timer\.Add_Tick\(\{ Refresh-Ui \}\)/);
  assert.match(source, /\$timer\.Start\(\)/);
  assert.match(source, /\[void\]\$form\.ShowDialog\(\)/);
});


test("Windows viewport probe executes the production layout helper without local runtime state", {
  skip: process.platform !== "win32"
}, () => {
  function probe(width, height) {
    const command = [
      "$source = Get-Content -LiteralPath $env:MAGASIN_PANEL_PATH -Raw -Encoding UTF8",
      "& ([ScriptBlock]::Create($source)) -ViewportProbe -ProbeWidth " + String(width) + " -ProbeHeight " + String(height)
    ].join("; ");
    const result = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, MAGASIN_PANEL_PATH: panelPath }
      }
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  }

  const large = probe(1920, 1040);
  assert.equal(large.initial_width, 1240);
  assert.equal(large.initial_height, 930);
  assert.equal(large.vertical_scroll_required, true);
  assert.equal(large.lane3_stop_in_canvas, true);

  const medium = probe(1600, 860);
  assert.equal(medium.initial_height, 860);
  assert.equal(medium.vertical_scroll_required, true);
  assert.equal(medium.lane3_stop_in_canvas, true);

  const low = probe(1366, 728);
  assert.equal(low.initial_width, 1240);
  assert.equal(low.initial_height, 728);
  assert.equal(low.minimum_width, 900);
  assert.equal(low.minimum_height, 600);
  assert.equal(low.vertical_scroll_required, true);
  assert.equal(low.lane3_stop_bottom, 1072);
  assert.equal(low.lane3_stop_in_canvas, true);
});

test("Windows actual WorkingArea probe stays inside the current monitor", {
  skip: process.platform !== "win32"
}, () => {
  const command = [
    "$source = Get-Content -LiteralPath $env:MAGASIN_PANEL_PATH -Raw -Encoding UTF8",
    "& ([ScriptBlock]::Create($source)) -ViewportProbe"
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, MAGASIN_PANEL_PATH: panelPath }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout.trim());
  assert.ok(actual.working_width > 0);
  assert.ok(actual.working_height > 0);
  assert.ok(actual.initial_width <= actual.working_width);
  assert.ok(actual.initial_height <= actual.working_height);
  assert.ok(actual.minimum_width <= actual.initial_width);
  assert.ok(actual.minimum_height <= actual.initial_height);
  assert.equal(actual.lane3_stop_in_canvas, true);
});
