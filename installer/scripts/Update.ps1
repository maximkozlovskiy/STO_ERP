#Requires -RunAsAdministrator
param(
    [string]$DataDir = 'C:\ProgramData\STO-ERP',
    [string]$Version = 'latest',
    # OFFLINE-FIRST: каталог із tar-бандлом нових образів (sto-api/sto-web:$Version .tar.gz), як у
    # Setup-Stack.ps1. Якщо заданий — образи завантажуються `docker load` локально (БЕЗ інтернету).
    # Порожній → fallback на `docker compose pull` (онлайн-сценарій).
    [string]$ImagesDir = ''
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
#
# ВАЖЛИВО (Bug #716): якщо попередня версія == цільова (типовий кейс — обидві плаваючий тег
# 'latest', бо .env за замовч. має VERSION=latest, а task кличе Update.ps1 без -Version), то
# re-pull того самого тега лише ПЕРЕТЯГНЕ той самий (щойно зламаний) образ — це НЕ відкат.
# Тоді відкату НЕМАЄ: чесно попереджаємо оператора замість фальшивого «відкат виконано».
function Invoke-Rollback {
    param([string]$reason)
    Write-Log "!!! ВІДКАТ: $reason"
    if ($previousVersion -eq $Version) {
        Write-Log "НЕМОЖЛИВО ВІДКОТИТИ: попередня і цільова версії однакові ('$Version')."
        Write-Log "  Плаваючий тег ('latest') не дає відкату — образ під тим самим тегом уже перезаписано."
        Write-Log "  Старі контейнери зупинено новою невдалою версією. Потрібне РУЧНЕ втручання:"
        Write-Log "  відновіть попередній образ з бекапу/бандлу і 'docker compose up -d api web',"
        Write-Log "  або закріпіть незмінні теги версій (VERSION=<конкретна> у .env) для авто-відкату."
        exit 1
    }
    try {
        $env:VERSION = $previousVersion
        # OFFLINE-FIRST: образ попередньої версії (sto-api:$previousVersion) уже завантажений
        # локально з попереднього install/update-бандла (docker load). Тому rollback = просто
        # `up -d` на цьому локальному тезі. `pull` НЕ роблять першим (offline → провал; онлайн-pull
        # лишаємо fallback-ом, якщо локального образу раптом немає).
        & docker compose up -d api web
        if ($LASTEXITCODE -ne 0) {
            Write-Log "Локальний образ $previousVersion не піднявся — пробуємо pull (потрібен інтернет)..."
            & docker compose pull api web
            if ($LASTEXITCODE -ne 0) { throw "docker compose pull попередньої версії ($previousVersion) впав" }
            & docker compose up -d api web
            if ($LASTEXITCODE -ne 0) { throw "docker compose up попередньої версії ($previousVersion) впав" }
        }
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

# 2. Завантаження нових образів — OFFLINE-FIRST через `docker load` з бандла (як Setup-Stack.ps1).
#    Онлайн `docker compose pull` лишається fallback-ом лише коли -ImagesDir не заданий.
$env:VERSION = $Version
if ($ImagesDir -and (Test-Path $ImagesDir)) {
    Write-Log "Завантаження нових образів з бандла (offline): $ImagesDir"
    $tars = Get-ChildItem "$ImagesDir\*.tar.gz" -ErrorAction SilentlyContinue
    if (-not $tars) { Write-Log "У $ImagesDir немає *.tar.gz образів"; exit 1 }
    foreach ($tar in $tars) {
        Write-Log "  docker load $($tar.Name)"
        & docker load -i $tar.FullName
        if ($LASTEXITCODE -ne 0) { Write-Log "docker load $($tar.Name) впав"; exit 1 }
    }
} else {
    Write-Log "Завантаження нових образів (online pull — -ImagesDir не заданий)..."
    & docker compose pull api web
    if ($LASTEXITCODE -ne 0) { Write-Log "docker compose pull завершився з помилкою"; exit 1 }
}

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
