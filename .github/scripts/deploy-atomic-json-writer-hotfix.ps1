param(
    [Parameter(Mandatory=$true)]
    [string]$TargetComputer
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if ($env:COMPUTERNAME -ne $TargetComputer) {
    Write-Host 'TARGET_MATCH=False'
    Write-Host 'TARGET_SKIP_SAFE=True'
    exit 0
}
Write-Host 'TARGET_MATCH=True'

$mutex = New-Object System.Threading.Mutex($false, 'Global\MAGASIN_ATOMIC_JSON_WRITER_HOTFIX_DEPLOY')
$ownsMutex = $false
try {
    try {
        $ownsMutex = $mutex.WaitOne([TimeSpan]::FromMinutes(4))
    } catch [System.Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }
    if (-not $ownsMutex) {
        throw 'Could not acquire targeted atomic-writer deployment mutex.'
    }

    . (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
    $root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
    $runtime = Join-Path $root 'runtime'
    $sourceCli = Join-Path $env:GITHUB_WORKSPACE 'src\runtime\three-lane-cli.mjs'
    $sourceWriter = Join-Path $env:GITHUB_WORKSPACE 'src\runtime\atomic-json-write.mjs'
    $targetCli = Join-Path $runtime 'src\runtime\three-lane-cli.mjs'
    $targetWriter = Join-Path $runtime 'src\runtime\atomic-json-write.mjs'
    $targetStart = Join-Path $runtime 'windows\start-supervisor.ps1'
    $targetLifecycle = Join-Path $runtime 'windows\lifecycle-truth.ps1'
    $configFile = Join-Path $root 'lanes.json'
    $statusFile = Join-Path $root 'lane-status.json'
    $registryFile = Join-Path $root 'lane-registry.json'
    $supervisorLog = Join-Path $root 'supervisor.log'
    $pidFile = Join-Path $root 'supervisor.pid'

    foreach ($required in @(
        $sourceCli,$sourceWriter,$targetCli,$targetStart,$targetLifecycle,$configFile,$registryFile
    )) {
        if (-not (Test-Path $required)) {
            throw "Required path is missing: $required"
        }
    }

    $sourceCliText = Get-Content $sourceCli -Raw -Encoding UTF8
    $sourceWriterText = Get-Content $sourceWriter -Raw -Encoding UTF8

    foreach ($marker in @(
        'import { atomicJsonWrite } from "./atomic-json-write.mjs"',
        'SUPERVISOR_STATE_ROOT'
    )) {
        if ($sourceCliText -notmatch [regex]::Escape($marker)) {
            throw "Checked-out Three-Lane source missing marker: $marker"
        }
    }
    foreach ($marker in @(
        'const writeQueues = new Map()',
        'randomUUID()',
        '.tmp.${process.pid}.${randomUUID()}',
        'writeQueues.set(resolved, operation)'
    )) {
        if ($sourceWriterText -notmatch [regex]::Escape($marker)) {
            throw "Checked-out atomic writer missing marker: $marker"
        }
    }

    function Get-TargetFingerprint([string]$Path) {
        $config = Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        $canonical = @($config.lanes | Sort-Object lane_id | ForEach-Object {
            "$([string]$_.lane_id)|$([bool]$_.enabled)|$([string]$_.brain_url)|$([int]$_.brain_url_revision)|$([string]$_.work_url)|$([int]$_.work_url_revision)|$([string]$_.work_mode)"
        }) -join "`n"
        $bytes = [Text.Encoding]::UTF8.GetBytes($canonical)
        $hasher = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()
        } finally {
            $hasher.Dispose()
        }
    }

    $fingerprintBefore = Get-TargetFingerprint $configFile

    . $targetLifecycle
    $ownerStop = Get-LifecycleOwnerStopState -Root $root
    if ($ownerStop.blocked) {
        throw 'Owner STOP is active; deployment refuses to override Owner authority.'
    }

    $truthBefore = Get-LifecycleProcessTruth -Root $root
    Write-Host "PRE_WRAPPER_ALIVE=$([bool]$truthBefore.wrapper_alive)"
    Write-Host "PRE_THREE_LANE_ALIVE=$([bool]$truthBefore.three_lane_alive)"
    Write-Host "PRE_CHROME_ALIVE=$([bool]$truthBefore.chrome_alive)"
    Write-Host "PRE_CDP_HEALTHY=$([bool]$truthBefore.cdp_healthy)"

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($targetWriter, $sourceWriterText, $utf8NoBom)
    [System.IO.File]::WriteAllText($targetCli, $sourceCliText, $utf8NoBom)

    if ((Get-FileHash -Algorithm SHA256 -Path $targetWriter).Hash -ne
        (Get-FileHash -Algorithm SHA256 -Path $sourceWriter).Hash) {
        throw 'Installed atomic-json-write.mjs hash does not match checked-out source.'
    }
    if ((Get-FileHash -Algorithm SHA256 -Path $targetCli).Hash -ne
        (Get-FileHash -Algorithm SHA256 -Path $sourceCli).Hash) {
        throw 'Installed three-lane-cli.mjs hash does not match checked-out source.'
    }
    Write-Host 'ATOMIC_WRITER_FILES_DEPLOYED=True'

    $probe = Join-Path $env:RUNNER_TEMP ('magasin-atomic-writer-probe-' + [guid]::NewGuid().ToString('N') + '.mjs')
    $probeText = @'
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const writerPath = process.argv[2];
const { atomicJsonWrite, pendingAtomicJsonWriteCount } =
  await import(pathToFileURL(writerPath).href);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-live-atomic-"));
const target = path.join(dir, "lane-registry.json");
try {
  const writes = [];
  for (let i = 0; i < 100; i += 1) {
    writes.push(atomicJsonWrite(target, {
      sequence: i,
      payload: "x".repeat(2048)
    }));
  }
  await Promise.all(writes);
  const parsed = JSON.parse(await fs.readFile(target, "utf8"));
  if (parsed.sequence !== 99) throw new Error("last queued snapshot was not preserved");
  if (pendingAtomicJsonWriteCount() !== 0) throw new Error("writer queue did not drain");
  const names = await fs.readdir(dir);
  const leftovers = names.filter((name) => name.startsWith("lane-registry.json.tmp."));
  if (leftovers.length) throw new Error("private temp files were left behind");
  console.log("LIVE_ATOMIC_WRITER_CONCURRENCY=PASS");
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
'@
    [System.IO.File]::WriteAllText($probe, $probeText, $utf8NoBom)
    try {
        & node.exe $probe $targetWriter
        if ($LASTEXITCODE -ne 0) {
            throw 'Installed atomic writer concurrency probe failed.'
        }
    } finally {
        Remove-Item $probe -Force -ErrorAction SilentlyContinue
    }

    $deployStarted = [DateTimeOffset]::UtcNow

    $wrapper = Get-LifecycleSupervisorWrapper -Root $root
    if ($wrapper) {
        Stop-Process -Id ([int]$wrapper.ProcessId) -Force -ErrorAction Stop
        Write-Host 'OLD_WRAPPER_STOPPED=True'
    }

    $runtimeRoot = Join-Path $root 'runtime'
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like '*three-lane-cli.mjs*' -and
            $_.CommandLine -like "*$runtimeRoot*"
        } |
        ForEach-Object {
            Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
            Write-Host 'OLD_THREE_LANE_NODE_STOPPED=True'
        }

    Start-Sleep -Milliseconds 900

    if (Test-Path $pidFile) {
        $pidText = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        $pidValue = 0
        if (-not $pidText -or
            -not [int]::TryParse([string]$pidText, [ref]$pidValue) -or
            -not (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
            Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        }
    }

    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $targetStart -Hidden -Recovery
    if ($LASTEXITCODE -ne 0) {
        throw 'Targeted Supervisor recovery start returned non-zero.'
    }
    Write-Host 'RECOVERY_START_REQUESTED=True'

    $finalTruth = $null
    $freshStatus = $null

    for ($i = 0; $i -lt 90; $i++) {
        Start-Sleep -Seconds 1
        $finalTruth = Get-LifecycleProcessTruth -Root $root

        if (Test-Path $statusFile) {
            try {
                $candidate = Get-Content $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
                $updated = [DateTimeOffset]::MinValue
                if (
                    [DateTimeOffset]::TryParse([string]$candidate.updated_at, [ref]$updated) -and
                    $updated.ToUniversalTime() -ge $deployStarted.AddSeconds(-2) -and
                    [string]$candidate.mode -eq 'THREE_LANE_V1'
                ) {
                    $freshStatus = $candidate
                }
            } catch {}
        }

        if ($finalTruth.healthy -and $freshStatus) { break }
    }

    if (-not $finalTruth -or -not $finalTruth.healthy) {
        if ($finalTruth) {
            Write-Host "POST_WRAPPER_ALIVE=$([bool]$finalTruth.wrapper_alive)"
            Write-Host "POST_THREE_LANE_ALIVE=$([bool]$finalTruth.three_lane_alive)"
            Write-Host "POST_CHROME_ALIVE=$([bool]$finalTruth.chrome_alive)"
            Write-Host "POST_CDP_HEALTHY=$([bool]$finalTruth.cdp_healthy)"
        }
        throw 'Runtime did not reach healthy process truth.'
    }
    if (-not $freshStatus) {
        throw 'lane-status.json did not receive a fresh Three-Lane heartbeat.'
    }

    Start-Sleep -Seconds 12
    $finalTruth = Get-LifecycleProcessTruth -Root $root
    if (-not $finalTruth.healthy) {
        throw 'Runtime lost healthy process truth during post-deploy soak.'
    }

    $statusNow = Get-Content $statusFile -Raw -Encoding UTF8
    if ($statusNow -match 'ENOENT|lane-registry\.json\.tmp') {
        throw 'Live lane status still reports the old lane-registry temp-file race.'
    }

    $newWriterErrors = @()
    if (Test-Path $supervisorLog) {
        foreach ($line in @(Get-Content $supervisorLog -Tail 600 -ErrorAction SilentlyContinue)) {
            try {
                $entry = $line | ConvertFrom-Json
                $ts = [DateTimeOffset]::MinValue
                if (
                    [DateTimeOffset]::TryParse([string]$entry.timestamp, [ref]$ts) -and
                    $ts.ToUniversalTime() -ge $deployStarted.AddSeconds(-2)
                ) {
                    $serialized = $entry | ConvertTo-Json -Compress -Depth 12
                    if ($serialized -match 'ENOENT|lane-registry\.json\.tmp') {
                        $newWriterErrors += $serialized
                    }
                }
            } catch {}
        }
    }
    if ($newWriterErrors.Count -gt 0) {
        throw 'New ENOENT/lane-registry temp-file errors appeared after deployment.'
    }

    if (Test-Path (Join-Path $root 'lane-registry.json.tmp')) {
        throw 'Legacy shared lane-registry.json.tmp artifact still exists.'
    }
    $privateTemps = @(Get-ChildItem -Path $root -Filter 'lane-registry.json.tmp.*' -File -ErrorAction SilentlyContinue)
    if ($privateTemps.Count -gt 0) {
        throw 'Private atomic writer temp files did not drain after the live soak.'
    }

    $fingerprintAfter = Get-TargetFingerprint $configFile
    if ($fingerprintBefore -ne $fingerprintAfter) {
        throw 'Brain/Work/lane target configuration changed during writer deployment.'
    }

    $lane1 = @($freshStatus.lanes | Where-Object { [string]$_.lane_id -eq 'lane-1' } | Select-Object -First 1)[0]

    Write-Host 'POST_WRAPPER_ALIVE=True'
    Write-Host 'POST_THREE_LANE_ALIVE=True'
    Write-Host 'POST_CHROME_ALIVE=True'
    Write-Host 'POST_CDP_HEALTHY=True'
    Write-Host 'AUTHORITATIVE_STATUS_FRESH=True'
    Write-Host "LANE1_STATUS=$([string]$lane1.status)"
    if ($lane1.PSObject.Properties['phase']) {
        Write-Host "LANE1_PHASE=$([string]$lane1.phase)"
    }
    Write-Host 'NEW_WRITER_ENOENT_COUNT=0'
    Write-Host 'ATOMIC_WRITER_TEMP_DRAINED=True'
    Write-Host 'TARGET_FINGERPRINT_UNCHANGED=True'
    Write-Host 'ATOMIC_JSON_WRITER_HOTFIX=PASS'
} finally {
    if ($ownsMutex) {
        try { $mutex.ReleaseMutex() } catch {}
    }
    $mutex.Dispose()
}
