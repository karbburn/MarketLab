# Start (or stop) the MarketLab market-data service as a background process.
# Used by the "MarketLab market-data" entry in the per-user Startup folder (see
# below), and safe to run by hand.
#
#   powershell -ExecutionPolicy Bypass -File start-service.ps1
#   powershell -ExecutionPolicy Bypass -File start-service.ps1 -Stop
#
# To install the logon entry (one-time, per user, no admin rights needed):
#   powershell -ExecutionPolicy Bypass -File start-service.ps1 -Install
#
# The service binds to 127.0.0.1:8787 only. Log: %LOCALAPPDATA%\MarketLab\market-data.log

param(
    [switch]$Stop,
    [switch]$Install,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$Port = 8787
$ServiceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $env:LOCALAPPDATA 'MarketLab'
$LogFile = Join-Path $LogDir 'market-data.log'
$PortPIDFile = Join-Path $LogDir 'market-data.pid'

function Get-ListeningPid {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return $conn | Select-Object -ExpandProperty OwningProcess -Unique
}

if ($Install) {
    # A Startup-folder shortcut (no admin rights required) that launches
    # pythonw.exe directly: uvicorn runs with no console window at all.
    $startup = [Environment]::GetFolderPath('Startup')
    $pythonw = (Get-Command 'pythonw' -ErrorAction SilentlyContinue).Source
    if (-not $pythonw) { $pythonw = (Get-Command python).Source -replace 'python\.exe$', 'pythonw.exe' }
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut((Join-Path $startup 'MarketLab market-data.lnk'))
    $lnk.TargetPath = $pythonw
    $lnk.Arguments = "-m uvicorn app:app --app-dir `"$ServiceDir`" --host 127.0.0.1 --port $Port"
    $lnk.WorkingDirectory = $ServiceDir
    $lnk.Save()
    Write-Output "Installed at $(Join-Path $startup 'MarketLab market-data.lnk')"
    Write-Output 'The service starts (hidden) at every logon; run with -Stop to stop it, or -Remove to remove the entry.'
    exit 0
}

if ($Remove) {
    $lnkFile = Join-Path [Environment]::GetFolderPath('Startup') 'MarketLab market-data.lnk'
    if (Test-Path $lnkFile) { Remove-Item $lnkFile -Force; Write-Output "Removed $lnkFile" }
    else { Write-Output 'Nothing to remove.' }
    exit 0
}

if (-not $Install -and $args.Count -eq 0) { } # no-op; kept for readability

if ($Stop) {
    $pid0 = Get-ListeningPid
    foreach ($p in $pid0) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
    if ($pid0) { Write-Output "Stopped service process(es): $($pid0 -join ', ')" } else { Write-Output 'Service was not running.' }
    exit 0
}

# Start
if (Get-ListeningPid) { exit 0 }   # already running; a second instance would fail to bind

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# idempotent port + explicit app dir so the task does not depend on the CWD
$python = (Get-Command python -ErrorAction Stop).Source
$process = Start-Process -FilePath $python -ArgumentList @(
    '-m', 'uvicorn', 'app:app', '--app-dir', "`"$ServiceDir`"",
    '--host', '127.0.0.1', '--port', "$Port"
) -WindowStyle Hidden -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" -WorkingDirectory $ServiceDir
$process.Id | Set-Content -Path $PortPIDFile

# Report readiness from the health endpoint (worst-day diagnosis goes to the log).
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try {
        if ((Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2).ok) { exit 0 }
    } catch { }
}
exit 1
