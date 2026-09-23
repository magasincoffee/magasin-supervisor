param(
  [Parameter(Mandatory=$true)][string]$CandidateScript,
  [Parameter(Mandatory=$true)][string]$SummaryPath,
  [int]$DurationMinutes = 1,
  [int]$SampleSeconds = 30
)

$ErrorActionPreference = "Stop"

try {
  & $CandidateScript -DurationMinutes $DurationMinutes -SampleSeconds $SampleSeconds -OutputPath $SummaryPath
  exit 0
} catch {
  $type = ($_.Exception.GetType().FullName -replace '[^A-Za-z0-9_.-]','_')
  $fqid = ([string]$_.FullyQualifiedErrorId -replace '[^A-Za-z0-9_.-]','_')
  $line = [int]$_.InvocationInfo.ScriptLineNumber
  $command = ([string]$_.InvocationInfo.MyCommand.Name -replace '[^A-Za-z0-9_.-]','_')
  Write-Output "SAFE_EXCEPTION_TYPE=$type"
  Write-Output "SAFE_FQID=$fqid"
  Write-Output "SAFE_SCRIPT_LINE=$line"
  Write-Output "SAFE_COMMAND=$command"
  exit 97
}
