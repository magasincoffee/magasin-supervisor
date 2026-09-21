Set-StrictMode -Version 2.0

function Get-SupervisorProjectAdapterSource {
    if ($env:MAGASIN_SUPERVISOR_PROJECT_ADAPTER) {
        return [string]$env:MAGASIN_SUPERVISOR_PROJECT_ADAPTER
    }
    throw 'MAGASIN_SUPERVISOR_PROJECT_ADAPTER is required.'
}

function Read-SupervisorProjectAdapter([string]$Source = (Get-SupervisorProjectAdapterSource)) {
    if ([string]::IsNullOrWhiteSpace($Source)) {
        throw 'Project adapter source is empty.'
    }

    if ($Source -match '^https://') {
        $adapter = Invoke-RestMethod -Uri $Source -TimeoutSec 5 -Headers @{ 'Cache-Control'='no-cache' }
    } else {
        if (-not (Test-Path $Source)) { throw "Project adapter file missing: $Source" }
        $adapter = Get-Content $Source -Raw -Encoding UTF8 | ConvertFrom-Json
    }

    if ([string]$adapter.schema_version -ne 'supervisor-project-adapter.v1') {
        throw 'Unsupported project adapter schema_version.'
    }
    if (-not $adapter.project -or -not $adapter.orchestration) {
        throw 'Project adapter requires project and orchestration objects.'
    }
    foreach ($name in @('id','name')) {
        if ([string]::IsNullOrWhiteSpace([string]$adapter.project.$name)) {
            throw "Project adapter project.$name is required."
        }
    }
    foreach ($name in @('current_phase','current_task','status','autonomy')) {
        if ([string]::IsNullOrWhiteSpace([string]$adapter.orchestration.$name)) {
            throw "Project adapter orchestration.$name is required."
        }
    }
    if ($adapter.orchestration.blocked -isnot [bool] -or $adapter.orchestration.requires_user -isnot [bool]) {
        throw 'Project adapter orchestration blocked/requires_user must be boolean.'
    }
    return $adapter
}

function ConvertTo-SupervisorProjectState($Adapter) {
    return [pscustomobject]@{
        project = [string]$Adapter.project.name
        project_id = [string]$Adapter.project.id
        repository = if ($Adapter.project.repository) { [string]$Adapter.project.repository } else { $null }
        current_phase = [string]$Adapter.orchestration.current_phase
        current_task = [string]$Adapter.orchestration.current_task
        current_task_title = [string]$Adapter.orchestration.current_task_title
        status = [string]$Adapter.orchestration.status
        autonomy = [string]$Adapter.orchestration.autonomy
        blocked = [bool]$Adapter.orchestration.blocked
        requires_user = [bool]$Adapter.orchestration.requires_user
        next_task = if ($Adapter.orchestration.next_task) { [string]$Adapter.orchestration.next_task } else { $null }
        supervisor_orchestration = $Adapter.orchestration.supervisor_orchestration
    }
}
