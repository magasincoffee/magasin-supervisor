import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("SC-013 overnight observer is valid PowerShell syntax", () => {
  const scriptPath = fileURLToPath(
    new URL("../.github/scripts/supervisor-sc013-overnight-observer.ps1", import.meta.url)
  );
  const escaped = scriptPath.replaceAll("'", "''");
  const command = [
    "$tokens=$null",
    "$errors=$null",
    `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null`,
    "if($errors.Count -gt 0){ $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
    "exit 0"
  ].join("; ");

  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Command", command],
    { encoding: "utf8" }
  );

  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n")
  );
});
