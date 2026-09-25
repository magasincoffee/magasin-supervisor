param([Parameter(Mandatory=$true)][string]$TargetComputer)
$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne $TargetComputer){Write-Host 'TARGET_MATCH=False';exit 0}
Write-Host 'TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$config=Get-Content (Join-Path $root 'lanes.json') -Raw -Encoding UTF8|ConvertFrom-Json
$lane=@($config.lanes|Where-Object{[string]$_.lane_id -eq 'lane-1'}|Select-Object -First 1)[0]
$brain=[string]$lane.brain_url
if([string]::IsNullOrWhiteSpace($brain)){throw 'lane-1 Brain URL is empty'}

$chrome=Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object {$_.CommandLine -match '--remote-debugging-port=(\d+)'} |
  Select-Object -First 1
if(-not $chrome){throw 'No dedicated Chrome CDP process found'}
[void]($chrome.CommandLine -match '--remote-debugging-port=(\d+)')
$port=[int]$Matches[1]
Write-Host "CDP_PORT=$port"

$nodeScript=Join-Path $env:RUNNER_TEMP ('brain-turns-'+[guid]::NewGuid().ToString('N')+'.mjs')
$adapterPath=(Join-Path $runtime 'src\ui\playwright-adapter.mjs').Replace('\','/')
$capturePath=(Join-Path $runtime 'src\ui\message-capture.mjs').Replace('\','/')
$lanePath=(Join-Path $runtime 'src\runtime\three-lane.mjs').Replace('\','/')
$brainEscaped=$brain.Replace('\','\\').Replace('"','\"')
$source=@"
import { pathToFileURL } from "node:url";
const adapterMod = await import(pathToFileURL("$adapterPath").href);
const captureMod = await import(pathToFileURL("$capturePath").href);
const laneMod = await import(pathToFileURL("$lanePath").href);
const { ChatGptUiAdapter } = adapterMod;
const { captureRecentConversationTurns } = captureMod;
const { parseLaneDirective } = laneMod;

const brainUrl = "$brainEscaped";
const target = new URL(brainUrl);
const adapter = new ChatGptUiAdapter({
  cdpUrl: "http://127.0.0.1:$port",
  timeoutMs: 15000,
  settleMs: 500
});
await adapter.open();
try {
  const page = adapter.getChatGptPages().find((p) => {
    try {
      const u = new URL(p.url());
      return u.origin === target.origin && u.pathname === target.pathname;
    } catch { return false; }
  });
  if (!page) {
    console.log("BRAIN_PAGE_FOUND=false");
    process.exit(0);
  }
  console.log("BRAIN_PAGE_FOUND=true");
  const turns = await captureRecentConversationTurns(page, { limit: 24 });
  console.log("TURN_COUNT=" + turns.length);
  for (let i = Math.max(0, turns.length - 12); i < turns.length; i += 1) {
    const t = turns[i];
    let directive = null;
    if (t.role === "assistant") {
      try { directive = parseLaneDirective(t.text); } catch {}
    }
    const markerMatch = /brain_request_id=([a-f0-9]{16,})/i.exec(t.text);
    const previous = directive?.previous_result || null;
    console.log([
      "TURN",
      i,
      "role="+t.role,
      "turn="+Number(t.turn||0),
      "chars="+Number(t.chars||0),
      "digest="+String(t.digest||"").slice(0,16),
      "brain_marker="+(markerMatch ? markerMatch[1] : ""),
      "directive="+String(directive?.action||""),
      "task="+String(directive?.task_id||""),
      "prev_task="+String(previous?.task_id||""),
      "prev_relay="+String(previous?.relay_id||"").slice(0,16),
      "verdict="+String(previous?.verdict||"")
    ].join("|"));
  }
} finally {
  await adapter.close().catch(() => {});
}
"@
[System.IO.File]::WriteAllText($nodeScript,$source,(New-Object System.Text.UTF8Encoding($false)))
try{
  & node.exe $nodeScript
  if($LASTEXITCODE -ne 0){throw "Node diagnostic failed: $LASTEXITCODE"}
}finally{
  Remove-Item $nodeScript -Force -ErrorAction SilentlyContinue
}
