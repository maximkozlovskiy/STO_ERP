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
        Get-Content $sqlFile.FullName |
            & docker compose exec -T postgres psql -U sto -d sto_erp
        if ($LASTEXITCODE -ne 0) { throw "psql відновлення завершилось з помилкою" }
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
