#Requires -RunAsAdministrator
param(
    [string]$AppDir  = 'C:\Program Files\STO-ERP',
    [string]$DataDir = 'C:\ProgramData\STO-ERP'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log { param([string]$msg) Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" }

# F2 — Windows Scheduled Tasks для offline on-prem СТО (мета ADR-007: без приїзду техспеца).
$scriptsDir = "$AppDir\scripts"

# ── 1. Щоденний авто-бекап (УВІМКНЕНО) ──────────────────────────────────────────
# Backup.ps1 уже має ротацію (KeepCount=30). Нічний запуск 02:30 — не конфліктує з
# reconciliation(02:00)/purge(03:00-04:00) на рівні застосунку (це рівень ОС).
$backupTask = 'STO-ERP Nightly Backup'
try {
    Unregister-ScheduledTask -TaskName $backupTask -Confirm:$false -ErrorAction SilentlyContinue
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptsDir\Backup.ps1`" -DataDir `"$DataDir`""
    $trigger = New-ScheduledTaskTrigger -Daily -At 2:30AM
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
        -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    Register-ScheduledTask -TaskName $backupTask -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings `
        -Description 'Щоденний резервний бекап STO ERP (pg_dump + MinIO + .env, ротація 30)' | Out-Null
    Write-Log "Заплановано '$backupTask' (щодня 02:30, УВІМКНЕНО)."
} catch {
    Write-Log "Не вдалося зареєструвати backup-task: $($_.Exception.Message)"
}

# ── 2. Перевірка оновлень (ЗАРЕЄСТРОВАНО, але ВИМКНЕНО — opt-in) ─────────────────
# Свідоме рішення: авто-update без нагляду на єдиному ПК СТО ризикований (неочікуваний
# downtime). Task створюється, щоб оператор МІГ увімкнути його вручну через Task Scheduler,
# але за замовч. вимкнений. Update.ps1 має rollback (F1) — якщо оператор увімкне, невдале
# оновлення відкотиться автоматично.
$updateTask = 'STO-ERP Auto Update (disabled)'
try {
    Unregister-ScheduledTask -TaskName $updateTask -Confirm:$false -ErrorAction SilentlyContinue
    $uAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptsDir\Update.ps1`" -DataDir `"$DataDir`""
    $uTrigger = New-ScheduledTaskTrigger -Daily -At 3:00AM
    $uPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $uSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Hours 1)
    Register-ScheduledTask -TaskName $updateTask -Action $uAction -Trigger $uTrigger `
        -Principal $uPrincipal -Settings $uSettings `
        -Description 'Авто-оновлення STO ERP (з rollback). ВИМКНЕНО за замовч. — увімкнути вручну.' | Out-Null
    Disable-ScheduledTask -TaskName $updateTask | Out-Null
    Write-Log "Заплановано '$updateTask' (щодня 03:00, ВИМКНЕНО — увімкнути вручну за потреби)."
} catch {
    Write-Log "Не вдалося зареєструвати update-task: $($_.Exception.Message)"
}

Write-Log "Реєстрація scheduled tasks завершена."
exit 0
