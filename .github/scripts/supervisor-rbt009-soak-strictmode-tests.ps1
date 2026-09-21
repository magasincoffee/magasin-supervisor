param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot "supervisor-rbt009-soak-lib.ps1")

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "ASSERT_TRUE failed: $Message" }
}

function Assert-Equal {
  param($Actual, $Expected, [string]$Message)
  if ($Actual -ne $Expected) {
    throw "ASSERT_EQUAL failed: $Message; actual=$Actual expected=$Expected"
  }
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("rbt009a-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

function Write-Lines {
  param([string]$Path, [string[]]$Lines, [bool]$FinalNewline = $true)
  $text = [string]::Join("`n", $Lines)
  if ($FinalNewline) { $text += "`n" }
  [System.IO.File]::WriteAllText($Path, $text, $utf8)
}

try {
  $file = Join-Path $tempRoot "events.ndjson"

  # A — ERROR with event_type + reason_code + lane_id.
  Write-Lines $file @('{"event_type":"ERROR","reason_code":"R1","lane_id":"lane-1"}')
  $stats = Get-Rbt009SafeEventStats -Path $file
  Assert-Equal $stats.error_recovery_tail 1 "A counted ERROR"
  Assert-Equal $stats.max_identical_error_recovery_tail 1 "A signature run"

  # B — ERROR missing reason_code.
  Write-Lines $file @('{"event_type":"ERROR","lane_id":"lane-1"}')
  $stats = Get-Rbt009SafeEventStats -Path $file
  Assert-Equal $stats.error_recovery_tail 1 "B missing reason_code tolerated"

  # C — ERROR missing lane_id.
  Write-Lines $file @('{"event_type":"ERROR","reason_code":"R2"}')
  $stats = Get-Rbt009SafeEventStats -Path $file
  Assert-Equal $stats.error_recovery_tail 1 "C missing lane_id tolerated"

  # D — RECOVERY missing both optional fields.
  Write-Lines $file @('{"event_type":"RECOVERY"}')
  $stats = Get-Rbt009SafeEventStats -Path $file
  Assert-Equal $stats.error_recovery_tail 1 "D missing reason and lane tolerated"

  # E — normal event missing optional fields.
  Write-Lines $file @('{"event_type":"WORK_ACTIVITY"}')
  $stats = Get-Rbt009SafeEventStats -Path $file
  Assert-Equal $stats.error_recovery_tail 0 "E non flood event safe"

  # F — malformed JSON line is skipped.
  Write-Lines $file @(
    '{"event_type":"ERROR","lane_id":"lane-1"}',
    '{"event_type":'
  )
  $stats = Get-Rbt009SafeEventStats -Path $file
  Assert-Equal $stats.error_recovery_tail 1 "F malformed line skipped"

  # G — partial final line is skipped.
  $complete = '{"event_type":"RECOVERY","reason_code":"BOOT"}'
  $partial = '{"event_type":"ERROR","reason_code":"PARTIAL"'
  [System.IO.File]::WriteAllText($file, $complete + "`n" + $partial, $utf8)
  $stats = Get-Rbt009SafeEventStats -Path $file
  Assert-Equal $stats.error_recovery_tail 1 "G partial final line skipped"

  # H — empty file is safe.
  [System.IO.File]::WriteAllText($file, "", $utf8)
  $stats = Get-Rbt009SafeEventStats -Path $file
  Assert-Equal $stats.file_length_bytes 0 "H empty length"
  Assert-Equal $stats.error_recovery_tail 0 "H empty event file safe"

  # I — very large file reads bounded bytes only.
  $writer = [System.IO.StreamWriter]::new($file, $false, $utf8)
  try {
    for ($i = 0; $i -lt 30000; $i++) {
      $writer.WriteLine('{"event_type":"WORK_ACTIVITY","task_id":"SAFE"}')
    }
  } finally {
    $writer.Dispose()
  }
  $stats = Get-Rbt009SafeEventStats -Path $file -MaxTailBytes 65536
  Assert-True ($stats.file_length_bytes -gt 65536) "I fixture is larger than tail cap"
  Assert-True ($stats.tail_bytes_read -le 65536) "I tail read is bounded"

  # J — concurrent writer handle does not block or crash bounded reader.
  Write-Lines $file @('{"event_type":"RECOVERY","reason_code":"START"}')
  $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
  $writerStream = [System.IO.FileStream]::new(
    $file,
    [System.IO.FileMode]::Append,
    [System.IO.FileAccess]::Write,
    $share
  )
  try {
    $bytes = $utf8.GetBytes('{"event_type":"ERROR","reason_code":"APPENDING"')
    $writerStream.Write($bytes, 0, $bytes.Length)
    $writerStream.Flush()
    $stats = Get-Rbt009SafeEventStats -Path $file
    Assert-Equal $stats.error_recovery_tail 1 "J partial concurrent append ignored safely"
  } finally {
    $writerStream.Dispose()
  }

  # K — unknown future event type is ignored safely.
  Write-Lines $file @('{"event_type":"FUTURE_SAFE_EVENT","new_optional":"x"}')
  $stats = Get-Rbt009SafeEventStats -Path $file
  Assert-Equal $stats.error_recovery_tail 0 "K unknown future event safe"

  # L — no raw/private fields are rendered into stats output.
  Write-Lines $file @('{"event_type":"ERROR","message_body":"SECRET https://chatgpt.com/c/private","cookie":"SECRET_COOKIE"}')
  $statsJson = (Get-Rbt009SafeEventStats -Path $file | ConvertTo-Json -Compress)
  Assert-True (-not $statsJson.Contains("SECRET")) "L private content absent from stats"
  Assert-True (-not $statsJson.Contains("chatgpt.com")) "L URL absent from stats"
  Assert-True (-not $statsJson.Contains("message_body")) "L raw field absent from stats"

  # M — 20 identical ERROR/RECOVERY signatures still trip flood statistic.
  $identical = @()
  for ($i = 0; $i -lt 20; $i++) {
    $identical += '{"event_type":"ERROR","reason_code":"LOOP","lane_id":"lane-2"}'
  }
  Write-Lines $file $identical
  $stats = Get-Rbt009SafeEventStats -Path $file
  Assert-Equal $stats.max_identical_error_recovery_tail 20 "M identical flood detected"

  # N — distinct signatures do not false-trigger.
  $distinct = @()
  for ($i = 0; $i -lt 25; $i++) {
    $distinct += ('{"event_type":"ERROR","reason_code":"R' + $i + '","lane_id":"lane-3"}')
  }
  Write-Lines $file $distinct
  $stats = Get-Rbt009SafeEventStats -Path $file
  Assert-Equal $stats.max_identical_error_recovery_tail 1 "N distinct signatures remain bounded"

  # O — direct optional property helper is StrictMode v2 safe.
  $event = '{"event_type":"ERROR"}' | ConvertFrom-Json
  Assert-Equal (Get-Rbt009OptionalProperty -Object $event -Name "reason_code" -DefaultValue "NONE") "NONE" "O strict optional getter"

  # P — pre-soak historical flood is baseline only; newly appended flood is monitored.
  $historical = @()
  for ($i = 0; $i -lt 25; $i++) {
    $historical += '{"event_type":"ERROR","reason_code":"OLD","lane_id":"lane-1"}'
  }
  Write-Lines $file $historical
  $baseline = Get-Rbt009SafeEventStats -Path $file
  Assert-True ($baseline.max_identical_error_recovery_tail -ge 20) "P historical fixture contains old flood"
  $offset = [int64]$baseline.file_length_bytes
  $window = Get-Rbt009IncrementalFloodState -Path $file -StartOffset $offset
  Assert-Equal $window.error_recovery_events 0 "P historical flood excluded from soak window"
  Assert-Equal $window.max_identical_run 0 "P no false positive from historical flood"

  # Q — newly appended identical flood is detected across bounded samples.
  $appendWriter = [System.IO.StreamWriter]::new($file, $true, $utf8)
  try {
    for ($i = 0; $i -lt 10; $i++) {
      $appendWriter.WriteLine('{"event_type":"RECOVERY","reason_code":"NEW_LOOP","lane_id":"lane-2"}')
    }
  } finally {
    $appendWriter.Dispose()
  }
  $window1 = Get-Rbt009IncrementalFloodState -Path $file -StartOffset $offset
  Assert-Equal $window1.max_identical_run 10 "Q first half of new flood"
  $appendWriter = [System.IO.StreamWriter]::new($file, $true, $utf8)
  try {
    for ($i = 0; $i -lt 10; $i++) {
      $appendWriter.WriteLine('{"event_type":"RECOVERY","reason_code":"NEW_LOOP","lane_id":"lane-2"}')
    }
  } finally {
    $appendWriter.Dispose()
  }
  $window2 = Get-Rbt009IncrementalFloodState -Path $file -StartOffset $window1.next_offset -PreviousSignature $window1.last_signature -PreviousRun $window1.current_identical_run
  Assert-Equal $window2.max_identical_run 20 "Q flood carry across samples"

  # R — incremental reader is bounded even when more data is appended than one sample cap.
  $offset = [int64](Get-Item -LiteralPath $file).Length
  $appendWriter = [System.IO.StreamWriter]::new($file, $true, $utf8)
  try {
    for ($i = 0; $i -lt 5000; $i++) {
      $appendWriter.WriteLine('{"event_type":"WORK_ACTIVITY","task_id":"SAFE"}')
    }
  } finally {
    $appendWriter.Dispose()
  }
  $window = Get-Rbt009IncrementalFloodState -Path $file -StartOffset $offset -MaxBytes 65536
  Assert-True ($window.bytes_read -le 65536) "R incremental bytes bounded"
  Assert-True ($window.next_offset -gt $offset) "R incremental cursor advances"

  Write-Host "RBT009A_STRICTMODE_V2=True"
  Write-Host "RBT009A_OPTIONAL_EVENT_FIELDS=True"
  Write-Host "RBT009A_MALFORMED_PARTIAL_SKIP=True"
  Write-Host "RBT009A_BOUNDED_TAIL_BYTES=True"
  Write-Host "RBT009A_CONCURRENT_APPEND_SAFE=True"
  Write-Host "RBT009A_UNKNOWN_EVENT_SAFE=True"
  Write-Host "RBT009A_PRIVACY_METADATA_ONLY=True"
  Write-Host "RBT009A_FLOOD_DETECTION=True"
  Write-Host "RBT009A_STRICTMODE_MATRIX_A_TO_O=PASS"
} finally {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
