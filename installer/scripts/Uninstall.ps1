#Requires -RunAsAdministrator
param(
    [string]$DataDir = 'C:\ProgramData\STO-ERP',
    [string]$AppDir  = 'C:\Program Files\STO-ERP',
    [switch]$KeepData
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'SilentlyContinue'

function Write-Log { param([string]$msg) Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" }

Add-Type -AssemblyName System.Windows.Forms

Write-Log "=== Видалення STO ERP ==="

if (-not $KeepData) {
    $confirm = [System.Windows.Forms.MessageBox]::Show(
        "Ви дійсно хочете видалити STO ERP?`n`nДані бази даних та файли будуть ЗБЕРЕЖЕНІ в:`n$DataDir`n`nДля повного видалення даних видаліть цю папку вручну.",
        "STO ERP — Підтвердження видалення",
        "YesNo", "Warning"
    )
    if ($confirm -ne "Yes") {
        Write-Log "Видалення скасовано користувачем."
        exit 0
    }
}

# 1. Stop and remove Windows Service
$nssm = "$AppDir\bin\nssm.exe"
if (Test-Path $nssm) {
    Write-Log "Зупинка Windows Service..."
    & $nssm stop 'STO-ERP' 2>$null
    & $nssm remove 'STO-ERP' confirm 2>$null
}

# 2. Stop Docker containers
Write-Log "Зупинка Docker контейнерів..."
if (Test-Path "$DataDir\docker-compose.yml") {
    Set-Location $DataDir
    & docker compose down 2>$null
}

# 3. Remove Docker volumes (only if user confirmed full removal)
if (-not $KeepData) {
    Write-Log "Видалення Docker volumes..."
    & docker volume rm sto-erp_postgres_data sto-erp_redis_data sto-erp_minio_data sto-erp_caddy_data 2>$null
}

# 4. Remove URL shortcut
Remove-Item "$DataDir\STO ERP.url" -Force -ErrorAction SilentlyContinue

Write-Log "=== Видалення завершено ==="
Write-Log "Дані збережено в: $DataDir"
exit 0
