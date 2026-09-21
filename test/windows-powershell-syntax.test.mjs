import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scripts = [
  "../windows/run-supervisor.ps1",
  "../windows/start-supervisor.ps1",
  "../windows/stop-supervisor.ps1",
  "../windows/lifecycle-truth.ps1",
  "../windows/install-supervisor.ps1",
  "../windows/repair-supervisor.ps1",
  "../windows/control-panel.ps1",
  "../windows/open-supervisor-chat.ps1",
  "../windows/collect-supervisor-diagnostics.ps1"
];

for (const relative of scripts) {
  test(`Windows PowerShell 5.1 parses ${relative}`, { skip: process.platform !== "win32" }, () => {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    let parseFile = file;
    let temporary = null;

    // control-panel.ps1 intentionally contains Vietnamese UI text. The real
    // installer rewrites it as UTF-8 with BOM before PowerShell 5.1 parses it,
    // so the syntax gate must exercise that same installed representation.
    if (relative.endsWith("control-panel.ps1")) {
      temporary = path.join(os.tmpdir(), `magasin-control-panel-${process.pid}.ps1`);
      fs.writeFileSync(temporary, "\uFEFF" + fs.readFileSync(file, "utf8"), "utf8");
      parseFile = temporary;
    }

    try {
      const escaped = parseFile.replaceAll("'", "''");
      const command = [
        "$errors = $null",
        `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$null, [ref]$errors) | Out-Null`,
        "if ($errors.Count -gt 0) {",
        "  $errors | ForEach-Object { Write-Error ($_.Message + ' at line ' + $_.Extent.StartLineNumber) }",
        "  exit 1",
        "}",
        "exit 0"
      ].join("; ");

      const result = spawnSync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command
      ], { encoding: "utf8" });

      assert.equal(
        result.status,
        0,
        `PowerShell parse failed for ${relative}:\n${result.stdout}\n${result.stderr}`
      );
    } finally {
      if (temporary) fs.rmSync(temporary, { force: true });
    }
  });
}
