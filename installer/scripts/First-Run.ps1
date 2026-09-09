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

# SECURITY (H-1): НЕ запускаємо demo-seed на проді.
# seed.ts створює загальновідомий admin@sto.local/admin123 — це критична вразливість,
# якщо потрапляє у production. Реальну організацію + OWNER-акаунт створює оператор
# через майстер першого запуску (/setup) у веб-інтерфейсі. Тут — лише міграції.
Write-Log "БД готова. Створення організації та адміністратора — через майстер /setup у браузері."

# Create MinIO default bucket
Write-Log "Створення MinIO bucket..."
& docker compose exec -T minio mc alias set local http://localhost:9000 `
    $env:MINIO_ACCESS_KEY $env:MINIO_SECRET_KEY 2>$null
& docker compose exec -T minio mc mb --ignore-existing local/sto-files

# F2: реєстрація scheduled tasks (нічний бекап + opt-in auto-update). Best-effort — невдача
# не має зривати перший запуск (задачі можна зареєструвати пізніше вручну).
Write-Log "Реєстрація запланованих задач (бекап/оновлення)..."
try {
    & "$PSScriptRoot\Register-ScheduledTasks.ps1" -DataDir $DataDir
} catch {
    Write-Log "Реєстрація scheduled tasks не вдалась (не критично): $($_.Exception.Message)"
}

New-Item -ItemType File -Force -Path $flagFile | Out-Null
Write-Log "Перший запуск завершено успішно."
exit 0
