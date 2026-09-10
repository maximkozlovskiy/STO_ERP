#Requires -RunAsAdministrator
param(
    [Parameter(Mandatory)][string]$BackupFile,
    [string]$DataDir = 'C:\ProgramData\STO-ERP'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log { param([string]$msg) Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" }

if (-not (Test-Path $BackupFile)) {
    throw "Файл бекапу не знайдено: $BackupFile"
}

$tempDir = "$env:TEMP\sto-erp-restore-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

Write-Log "=== Відновлення STO ERP з $BackupFile ==="

try {
    # 1. Extract backup
    Write-Log "Розпакування архіву..."
    Expand-Archive -Path $BackupFile -DestinationPath $tempDir -Force

    # 2. Stop stack
    Write-Log "Зупинка STO ERP..."
    Set-Location $DataDir
    & docker compose stop

    # 3. Restore PostgreSQL
    Write-Log "Відновлення бази даних..."
    & docker compose start postgres
    Start-Sleep 10

    $sqlFile = Get-ChildItem $tempDir -Filter 'database.sql' | Select-Object -First 1
    if ($sqlFile) {
        # T23: копіюємо дамп У контейнер і виконуємо psql на файлі ВСЕРЕДИНІ — БЕЗ PowerShell-pipe
        #   (`Get-Content | psql` читав порядково й спотикався на BOM першого рядка).
        #   Дамп зроблено з `--clean --if-exists` (Backup.ps1) → DROP ... IF EXISTS перед CREATE, тож
        #   restore у непорожню БД не конфліктує. `-v ON_ERROR_STOP=1` → psql падає на першій помилці
        #   (інакше часткове відновлення тихо «успішне»).
        $pgId = (& docker compose ps -q postgres).Trim()
        if (-not $pgId) { throw "Не знайдено контейнер postgres" }
        & docker cp $sqlFile.FullName "${pgId}:/tmp/sto_restore.sql"
        if ($LASTEXITCODE -ne 0) { throw "docker cp дампу у контейнер завершився з помилкою" }
        & docker compose exec -T postgres psql -U sto -d sto_erp -v ON_ERROR_STOP=1 -f /tmp/sto_restore.sql
        $psqlExit = $LASTEXITCODE
        & docker compose exec -T postgres rm -f /tmp/sto_restore.sql
        if ($psqlExit -ne 0) { throw "psql відновлення завершилось з помилкою (код $psqlExit)" }
    }

    # 4. Restore MinIO
    $minioDir = Join-Path $tempDir 'minio'
    if (Test-Path $minioDir) {
        Write-Log "Відновлення файлів MinIO..."
        & docker compose start minio
        Start-Sleep 5
        & docker compose exec -T minio mc mirror $minioDir /data
    }

    # 5. Restart full stack
    Write-Log "Запуск STO ERP..."
    & docker compose up -d
    if ($LASTEXITCODE -ne 0) { throw "docker compose up завершився з помилкою" }

    Write-Log "=== Відновлення завершено успішно ==="
} finally {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

exit 0
