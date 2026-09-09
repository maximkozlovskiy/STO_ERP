#Requires -RunAsAdministrator
param(
    [string]$DataDir   = 'C:\ProgramData\STO-ERP',
    [string]$BackupDir = '',
    [int]$KeepCount    = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log { param([string]$msg) Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" }

if (-not $BackupDir) { $BackupDir = "$DataDir\backups" }
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$timestamp  = Get-Date -Format 'yyyy-MM-dd_HH-mm'
$backupPath = "$BackupDir\backup_$timestamp"
New-Item -ItemType Directory -Force -Path $backupPath | Out-Null

Set-Location $DataDir

# 1. PostgreSQL dump
Write-Log "Резервне копіювання бази даних..."
& docker compose exec -T postgres pg_dump -U sto sto_erp |
    Set-Content "$backupPath\database.sql" -Encoding UTF8
if ($LASTEXITCODE -ne 0) { throw "pg_dump завершився з помилкою" }

# 2. .env (encrypt sensitive data)
Write-Log "Збереження конфігурації..."
Copy-Item "$DataDir\.env" "$backupPath\.env"

# 3. MinIO data snapshot (via mc mirror)
Write-Log "Резервне копіювання файлів MinIO..."
$minioBackup = "$backupPath\minio"
New-Item -ItemType Directory -Force -Path $minioBackup | Out-Null
& docker compose exec -T minio mc mirror /data $minioBackup 2>$null

# 4. Compress to zip
Write-Log "Стиснення архіву..."
Compress-Archive -Path "$backupPath\*" -DestinationPath "$backupPath.zip" -CompressionLevel Optimal
Remove-Item $backupPath -Recurse -Force

# 5. Rotate old backups
Write-Log "Ротація старих бекапів (зберігаємо останні $KeepCount)..."
Get-ChildItem $BackupDir -Filter 'backup_*.zip' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $KeepCount |
    ForEach-Object {
        Write-Log "  Видалення старого бекапу: $($_.Name)"
        Remove-Item $_.FullName -Force
    }

$sizeMB = [math]::Round((Get-Item "$backupPath.zip").Length / 1MB, 1)
Write-Log "Бекап збережено: $backupPath.zip ($sizeMB МБ)"
exit 0
