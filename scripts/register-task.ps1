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
$envPath = Join-Path $repoRoot ".env"
$rawSchedule = $null
if (Test-Path $envPath) {
    foreach ($line in (Get-Content -Path $envPath)) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $parts = $trimmed -split '=', 2
        if ($parts[0].Trim() -eq 'CAPTURE_SCHEDULE') {
            $rawSchedule = $parts[1].Trim().Trim('"', "'")
            break
        }
    }
}

$cron = if ([string]::IsNullOrWhiteSpace($rawSchedule)) { '0 9,13,17 * * *' } else { $rawSchedule }
$fields = $cron.Trim() -split '\s+'
if ($fields.Count -ne 5) {
    throw "Invalid CAPTURE_SCHEDULE: expected 5 fields (minute hour dom month dow), got '$cron'"
}
$minField, $hourField, $domField, $monthField, $dowField = $fields

function Expand-CronField {
    param(
        [string]$Field,
        [int]$Min,
        [int]$Max
    )
    $values = [System.Collections.Generic.List[int]]::new()
    $items = $Field -split ','
    foreach ($item in $items) {
        $item = $item.Trim()
        if ($item -match '^\*/(\d+)$') {
            $step = [int]$Matches[1]
            if ($step -le 0) { throw "Invalid step in cron field: $item" }
            for ($i = $Min; $i -le $Max; $i += $step) {
                $values.Add($i)
            }
        } elseif ($item -eq '*') {
            for ($i = $Min; $i -le $Max; $i++) {
                $values.Add($i)
            }
        } elseif ($item -match '^(\d+)-(\d+)(?:/(\d+))?$') {
            $start = [int]$Matches[1]
            $end = [int]$Matches[2]
            $step = if ($Matches[3]) { [int]$Matches[3] } else { 1 }
            if ($step -le 0) { throw "Invalid step in cron field: $item" }
            if ($start -lt $Min -or $end -gt $Max -or $start -gt $end) {
                throw "Range $item out of bounds [$Min..$Max]"
            }
            for ($i = $start; $i -le $end; $i += $step) {
                $values.Add($i)
            }
        } elseif ($item -match '^\d+$') {
            $val = [int]$item
            if ($val -lt $Min -or $val -gt $Max) {
                throw "Value $item out of bounds [$Min..$Max]"
            }
            $values.Add($val)
        } else {
            throw "Unsupported cron syntax in field: '$item'"
        }
    }
    return ($values | Sort-Object -Unique)
}

if ($domField -ne '*' -or $monthField -ne '*') {
    # ponytail: dom/month cron fields warn-only; add wrapper runner when monthly schedules needed.
    Write-Warning "Day-of-month ('$domField') and month ('$monthField') fields have limited Task Scheduler support; scheduling daily/weekly at specified times instead."
}

$minutes = Expand-CronField -Field $minField -Min 0 -Max 59
$hours = Expand-CronField -Field $hourField -Min 0 -Max 23

$dowMap = @{
    0 = 'Sunday'
    1 = 'Monday'
    2 = 'Tuesday'
    3 = 'Wednesday'
    4 = 'Thursday'
    5 = 'Friday'
    6 = 'Saturday'
    7 = 'Sunday'
}

$daysOfWeek = $null
if ($dowField -ne '*') {
    $dowNumbers = Expand-CronField -Field $dowField -Min 0 -Max 7
    $daysOfWeek = @($dowNumbers | ForEach-Object { $dowMap[$_] } | Select-Object -Unique)
    if ($daysOfWeek.Count -eq 7) {
        $daysOfWeek = $null
    }
}

$triggers = @()
$triggerTimes = @()
foreach ($h in $hours) {
    foreach ($m in $minutes) {
        $timeStr = "{0:D2}:{1:D2}" -f $h, $m
        $triggerTimes += $timeStr
        if ($daysOfWeek) {
            $triggers += (New-ScheduledTaskTrigger -Weekly -DaysOfWeek $daysOfWeek -At $timeStr)
        } else {
            $triggers += (New-ScheduledTaskTrigger -Daily -At $timeStr)
        }
    }
}

if ($triggers.Count -eq 0) {
    throw "No triggers generated from CAPTURE_SCHEDULE '$cron'"
}
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal -Description "Captures primary desktop and uploads to Discord webhook at scheduled intervals" | Out-Null

Write-Host "Task successfully registered: $taskName"
$scheduleSummary = if ($daysOfWeek) {
    "$($triggerTimes -join ', ') on $($daysOfWeek -join ', ')"
} else {
    "$($triggerTimes -join ', ') daily"
}
Write-Host "Schedule: $scheduleSummary (cron: $cron)"
Write-Host "Working directory: $repoRoot"
Write-Host "Executable: $bunPath"
