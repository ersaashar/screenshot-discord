$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$bunCmd = Get-Command bun.exe -ErrorAction SilentlyContinue
if ($bunCmd) {
    $bunPath = $bunCmd.Source
} else {
    $fallback = Join-Path $HOME ".bun\bin\bun.exe"
    if (Test-Path $fallback) {
        $bunPath = (Resolve-Path $fallback).Path
    } else {
        throw "bun.exe not found on PATH or in $HOME\.bun\bin\bun.exe. Install Bun or add it to PATH."
    }
}

$taskName = "Screen Capture to Discord"
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    throw "Scheduled task '$taskName' already exists. To re-register, remove existing task first: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
}

$action = New-ScheduledTaskAction -Execute $bunPath -Argument "run src/capture.ts" -WorkingDirectory $repoRoot
$triggers = @(
    (New-ScheduledTaskTrigger -Daily -At '09:00'),
    (New-ScheduledTaskTrigger -Daily -At '13:00'),
    (New-ScheduledTaskTrigger -Daily -At '17:00')
)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal -Description "Captures primary desktop and uploads to Discord webhook at scheduled intervals" | Out-Null

Write-Host "Task successfully registered: $taskName"
Write-Host "Schedule: 09:00, 13:00, 17:00 daily"
Write-Host "Working directory: $repoRoot"
Write-Host "Executable: $bunPath"
