#Requires -RunAsAdministrator
param(
    [string]$DataDir = 'C:\ProgramData\STO-ERP'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log { param([string]$msg) Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" }

# Зупинка стека STO ERP. Пункт меню «Зупинити STO ERP» раніше помилково вказував на Update.ps1
# (нетехнічний власник, натиснувши «Зупинити», запускав повне оновлення з backup/міграціями/
# рестартом). Цей скрипт лише зупиняє контейнери, лишаючи дані (volumes) недоторканими.
# Запуск назад — через `docker compose up -d` (restart:unless-stopped підніме автоматично при
# старті Docker) або повторний First-Run/ярлик запуску.

Set-Location $DataDir

Write-Log "=== Зупинка STO ERP ==="
& docker compose stop
if ($LASTEXITCODE -ne 0) {
    Write-Log "docker compose stop завершився з помилкою (код $LASTEXITCODE)"
    exit 1
}
Write-Log "STO ERP зупинено. Дані збережено. Для запуску: 'docker compose up -d' у $DataDir."
exit 0
