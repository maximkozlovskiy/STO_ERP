#Requires -RunAsAdministrator
param(
    [string]$DataDir = 'C:\ProgramData\STO-ERP'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log { param([string]$msg) Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" }

$flagFile = "$DataDir\.first-run-done"
if (Test-Path $flagFile) {
    Write-Log "Перший запуск вже виконувався — пропускаємо."
    exit 0
}

Set-Location $DataDir

# Run DB migrations
Write-Log "Застосування міграцій бази даних..."
& docker compose exec -T api npx prisma migrate deploy
if ($LASTEXITCODE -ne 0) { throw "Міграція БД завершилась з помилкою" }

# Run seed (creates default org + admin account)
Write-Log "Початкове наповнення бази даних..."
& docker compose exec -T api npx prisma db seed
if ($LASTEXITCODE -ne 0) { throw "Seed БД завершився з помилкою" }

# Create MinIO default bucket
Write-Log "Створення MinIO bucket..."
& docker compose exec -T minio mc alias set local http://localhost:9000 `
    $env:MINIO_ACCESS_KEY $env:MINIO_SECRET_KEY 2>$null
& docker compose exec -T minio mc mb --ignore-existing local/sto-files

New-Item -ItemType File -Force -Path $flagFile | Out-Null
Write-Log "Перший запуск завершено успішно."
exit 0
