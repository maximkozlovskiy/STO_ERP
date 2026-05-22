#Requires -RunAsAdministrator
param(
    [string]$AppDir  = 'C:\Program Files\STO-ERP',
    [string]$DataDir = 'C:\ProgramData\STO-ERP'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log { param([string]$msg) Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" }

$serviceName = 'STO-ERP'
$nssm        = "$AppDir\bin\nssm.exe"

if (-not (Test-Path $nssm)) {
    Write-Log "NSSM не знайдено — пропускаємо реєстрацію Windows Service."
    exit 0
}

# Remove old service if exists
$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Log "Видалення старого сервісу..."
    & $nssm stop $serviceName 2>$null
    & $nssm remove $serviceName confirm
}

# Register new service via NSSM
Write-Log "Реєстрація Windows Service '$serviceName'..."
& $nssm install $serviceName "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe"
& $nssm set $serviceName AppParameters "compose --project-directory `"$DataDir`" up"
& $nssm set $serviceName AppDirectory $DataDir
& $nssm set $serviceName Description "STO ERP — система управління автосервісом"
& $nssm set $serviceName Start SERVICE_AUTO_START
& $nssm set $serviceName AppStopMethodSkip 0
& $nssm set $serviceName AppStopMethodConsole 5000
& $nssm set $serviceName AppStopMethodWindow 5000
& $nssm set $serviceName AppStopMethodThreads 5000
& $nssm set $serviceName AppRestartDelay 10000
& $nssm set $serviceName AppStdout "$DataDir\logs\service-stdout.log"
& $nssm set $serviceName AppStderr "$DataDir\logs\service-stderr.log"
& $nssm set $serviceName AppRotateFiles 1
& $nssm set $serviceName AppRotateBytes 10485760

New-Item -ItemType Directory -Force -Path "$DataDir\logs" | Out-Null

& $nssm start $serviceName
Write-Log "Windows Service '$serviceName' зареєстровано і запущено."
exit 0
