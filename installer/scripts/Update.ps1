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

# F1: фіксуємо ПОТОЧНУ версію для rollback. .env містить VERSION попереднього успішного деплою
# (First-Run/попередній Update його пишуть). Якщо немає — 'latest' (rollback = re-pull того ж тега).
$previousVersion = 'latest'
$envFile = Join-Path $DataDir '.env'
if (Test-Path $envFile) {
    $verLine = Select-String -Path $envFile -Pattern '^VERSION=' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($verLine) { $previousVersion = ($verLine.Line -replace '^VERSION=', '').Trim() }
}
Write-Log "Поточна версія (для відкату): $previousVersion"

# Rollback: повертає попередні образи й піднімає їх; лишає БД як є (міграції additive-only —
# гарантія A4 CI-guard, тож старий код проти новішої схеми сумісний). exit 1 — сигнал невдачі.
function Invoke-Rollback {
    param([string]$reason)
    Write-Log "!!! ВІДКАТ: $reason"
    try {
        $env:VERSION = $previousVersion
        & docker compose pull api web
        & docker compose up -d api web
        Write-Log "Відкат до $previousVersion виконано. Перевірте стан сервісу вручну."
    } catch {
        Write-Log "ВІДКАТ ТЕЖ ВПАВ: $($_.Exception.Message). Потрібне ручне втручання."
    }
    exit 1
}

# 1. Backup before update
Write-Log "Створення резервної копії перед оновленням..."
& "$PSScriptRoot\Backup.ps1" -DataDir $DataDir
if ($LASTEXITCODE -ne 0) { Write-Log "Бекап завершився з помилкою"; exit 1 }

# 2. Pull new images
Write-Log "Завантаження нових образів..."
$env:VERSION = $Version
& docker compose pull api web
if ($LASTEXITCODE -ne 0) { Write-Log "docker compose pull завершився з помилкою"; exit 1 }

# 3. Run migrations FIRST — one-off `run --rm` контейнер, СТАРІ api/web ще працюють і обслуговують.
#    Якщо міграція впала — старі контейнери живі, просто виходимо (без відкату образів, бо нові ще
#    не піднято). Additive-only міграції → безпечно навіть якщо частина застосувалась.
Write-Log "Застосування міграцій бази даних..."
& docker compose run --rm api npx prisma migrate deploy
if ($LASTEXITCODE -ne 0) { Write-Log "Міграція БД впала — старі контейнери працюють далі"; exit 1 }

# 4. Stop + start new containers
Write-Log "Перезапуск api та web на нову версію..."
& docker compose stop api web
& docker compose up -d api web
if ($LASTEXITCODE -ne 0) { Invoke-Rollback 'docker compose up завершився з помилкою' }

# 5. Health check — F1: при таймауті ВІДКАТ + exit 1 (раніше exit 0 навіть на невдачі).
Write-Log "Перевірка готовності API..."
$maxWait = 60; $elapsed = 0; $healthy = $false
do {
    Start-Sleep 5; $elapsed += 5
    try {
        # /api/health/live — liveness (не залежить від блимання Redis/MinIO).
        $resp = Invoke-WebRequest -Uri 'http://localhost:3000/api/health/live' -TimeoutSec 5 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
    Write-Log "  Очікування... ($elapsed / $maxWait сек)"
} while ($elapsed -lt $maxWait)

if (-not $healthy) {
    Invoke-Rollback "API не піднявся за $maxWait сек на новій версії $Version"
}

# 6. Успіх — фіксуємо нову версію як поточну для наступного rollback-орієнтира.
if (Test-Path $envFile) {
    $content = Get-Content $envFile
    if ($content -match '^VERSION=') {
        ($content -replace '^VERSION=.*', "VERSION=$Version") | Set-Content $envFile -Encoding utf8
    } else {
        Add-Content $envFile "VERSION=$Version" -Encoding utf8
    }
}

Write-Log "=== Оновлення STO ERP до $Version завершено успішно ==="
exit 0
