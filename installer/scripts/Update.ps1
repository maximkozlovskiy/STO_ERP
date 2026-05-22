#Requires -RunAsAdministrator
param(
    [string]$DataDir = 'C:\ProgramData\STO-ERP',
    [string]$Version = 'latest'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log { param([string]$msg) Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" }

Set-Location $DataDir

Write-Log "=== Оновлення STO ERP до версії $Version ==="

# 1. Backup before update
Write-Log "Створення резервної копії перед оновленням..."
& "$PSScriptRoot\Backup.ps1" -DataDir $DataDir
if ($LASTEXITCODE -ne 0) { throw "Бекап перед оновленням завершився з помилкою" }

# 2. Pull new images
Write-Log "Завантаження нових образів..."
$env:VERSION = $Version
& docker compose pull api web
if ($LASTEXITCODE -ne 0) { throw "docker compose pull завершився з помилкою" }

# 3. Stop API and Web only (DB keeps running)
Write-Log "Зупинка api та web..."
& docker compose stop api web

# 4. Run migrations
Write-Log "Застосування міграцій бази даних..."
& docker compose run --rm api npx prisma migrate deploy
if ($LASTEXITCODE -ne 0) { throw "Міграція БД завершилась з помилкою" }

# 5. Start new containers
Write-Log "Запуск нових контейнерів..."
& docker compose up -d api web
if ($LASTEXITCODE -ne 0) { throw "docker compose up завершився з помилкою" }

# 6. Health check
Write-Log "Перевірка готовності API..."
$maxWait = 60; $elapsed = 0
do {
    Start-Sleep 5; $elapsed += 5
    try {
        $resp = Invoke-WebRequest -Uri 'http://localhost:3000/api/health' -TimeoutSec 5 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { break }
    } catch { }
    Write-Log "  Очікування... ($elapsed / $maxWait сек)"
} while ($elapsed -lt $maxWait)

Write-Log "=== Оновлення STO ERP завершено ==="
exit 0
