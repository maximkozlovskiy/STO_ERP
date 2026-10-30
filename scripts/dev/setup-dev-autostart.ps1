# Автозапуск dev-середовища STO ERP: задача планувальника «STO Dev Servers» тримає сторож
# scripts/dev/dev-watchdog.ps1 (Docker-стек, API :3000, web :3001) — за зразком «STO WSL Docker».
#
#   powershell -File scripts/dev/setup-dev-autostart.ps1          # встановити / оновити й запустити
#   powershell -File scripts/dev/setup-dev-autostart.ps1 -Remove  # прибрати задачу
#
# Тригери: вхід користувача + повтор щохвилини (IgnoreNew — поки сторож живий, повтор нічого не
# робить; впав сторож — за хвилину піднімається знову). Без вікна (conhost --headless).
# Права адміністратора не потрібні: задача — лише для поточного користувача.
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$taskName = 'STO Dev Servers'

# Stop-ScheduledTask гасить лише conhost, а powershell сторожа лишається жити зі СТАРИМ кодом і
# тримає мьютекс — новий екземпляр одразу виходить. Тому старий сторож зупиняємо явно (сервери,
# які він запустив, живуть далі — вони не в його дереві).
function Stop-Watchdog {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -match 'dev-watchdog\.ps1' -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Remove) {
  Stop-Watchdog
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Задачу «$taskName» прибрано. Запущені сервери не зупинено."
  exit 0
}

$watchdog = Join-Path $PSScriptRoot 'dev-watchdog.ps1'
if (-not (Test-Path $watchdog)) { throw "Немає $watchdog" }

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
  -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$watchdog`""
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$keepAlive = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $keepAlive) -Settings $settings `
  -Principal $principal -Description 'STO ERP: сторож dev-середовища (scripts/dev/dev-watchdog.ps1) — Docker, API :3000, web :3001' `
  -Force | Out-Null

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Stop-Watchdog
Start-ScheduledTask -TaskName $taskName
$log = Join-Path $env:LOCALAPPDATA 'sto-erp\dev-watchdog\watchdog.log'
Write-Host "Задачу «$taskName» зареєстровано й запущено. Журнал сторожа: $log"
