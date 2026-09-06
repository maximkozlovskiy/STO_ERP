#Requires -RunAsAdministrator
param(
    [string]$DataDir   = 'C:\ProgramData\STO-ERP',
    [string]$ImagesDir = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log { param([string]$msg) Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" }
function New-RandomBase64 { param([int]$bytes = 32)
    return [System.Convert]::ToBase64String(
        [System.Security.Cryptography.RandomNumberGenerator]::GetBytes($bytes)
    ) -replace '[^a-zA-Z0-9]', '' | Select-Object -First 1
}

# 1. Create data directory structure
Write-Log "Створення директорій даних у $DataDir..."
@($DataDir, "$DataDir\postgres", "$DataDir\redis", "$DataDir\minio", "$DataDir\backups") |
    ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }

# 2. Load Docker images from bundle
if ($ImagesDir -and (Test-Path $ImagesDir)) {
    Write-Log "Завантаження Docker образів з бандлу..."
    Get-ChildItem "$ImagesDir\*.tar.gz" | ForEach-Object {
        Write-Log "  Завантаження $($_.Name)..."
        & docker load -i $_.FullName
        if ($LASTEXITCODE -ne 0) { throw "Помилка завантаження образу: $($_.Name)" }
    }
} else {
    Write-Log "Бандл образів не знайдено — завантаження з Docker Hub (потрібен інтернет)..."
    & docker compose -f "$DataDir\docker-compose.yml" pull
}

# 3. Generate secrets (write only if .env doesn't exist)
$envFile = "$DataDir\.env"
if (-not (Test-Path $envFile)) {
    Write-Log "Генерація секретів..."
    $pgPass     = New-RandomBase64 -bytes 24
    $minioKey   = New-RandomBase64 -bytes 24
    $jwtAccess  = New-RandomBase64 -bytes 48
    $jwtRefresh = New-RandomBase64 -bytes 48
    # Ключ шифрування секретів at-rest (SMS/ПРРО). Генерується ОДИН раз разом із .env;
    # оскільки .env перевикористовується при оновленні (гілка else нижче), ключ ніколи
    # не регенерується — інакше наявні зашифровані креди стануть недешифровними.
    $encKey     = New-RandomBase64 -bytes 48

    @"
# STO ERP — Production Environment
# Згенеровано автоматично під час встановлення
# НЕ редагуйте вручну без розуміння наслідків

POSTGRES_USER=sto
POSTGRES_PASSWORD=$pgPass
POSTGRES_DB=sto_erp
DATABASE_URL=postgresql://sto:${pgPass}@postgres:5432/sto_erp

REDIS_URL=redis://redis:6379

MINIO_ENDPOINT=minio
MINIO_PORT=9000
MINIO_ACCESS_KEY=stoerp
MINIO_SECRET_KEY=$minioKey
MINIO_BUCKET=sto-files
MINIO_USE_SSL=false

JWT_ACCESS_SECRET=$jwtAccess
JWT_REFRESH_SECRET=$jwtRefresh
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=30d

NOTIFICATION_ENC_KEY=$encKey

NODE_ENV=production
TZ=Europe/Kyiv
VERSION=latest
"@ | Set-Content $envFile -Encoding UTF8
    Write-Log "Файл .env створено."
} else {
    Write-Log "Файл .env вже існує — використовуємо наявні налаштування."
}

# 4. Write URL shortcut for browser access
@"
[InternetShortcut]
URL=http://localhost
"@ | Set-Content "$DataDir\STO ERP.url" -Encoding ASCII

# 5. Start stack
Write-Log "Запуск STO ERP stack..."
Set-Location $DataDir
& docker compose --env-file $envFile up -d
if ($LASTEXITCODE -ne 0) { throw "docker compose up завершився з помилкою" }

# 6. Wait for all services healthy
Write-Log "Очікування готовності всіх сервісів..."
$maxWait = 180; $elapsed = 0
do {
    Start-Sleep 5; $elapsed += 5
    $statuses = & docker compose ps --format json 2>$null |
        ForEach-Object { $_ | ConvertFrom-Json }
    $notHealthy = $statuses | Where-Object { $_.Health -notin @('healthy', '') -and $_.State -eq 'running' }
    $notRunning  = $statuses | Where-Object { $_.State -ne 'running' }
    Write-Log "  Очікування... ($elapsed / $maxWait сек)"
} while (($notHealthy.Count -gt 0 -or $notRunning.Count -gt 0) -and $elapsed -lt $maxWait)

if ($elapsed -ge $maxWait) {
    Write-Log "УВАГА: Деякі сервіси не відповіли вчасно. Перевірте логи: docker compose logs"
}

Write-Log "STO ERP успішно розгорнуто!"
Write-Log "Відкрийте у браузері: http://localhost"
exit 0
