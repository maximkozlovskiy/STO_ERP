# Docker у WSL піднімається сам і не гасне: dev-стек STO ERP (postgres, redis, minio) і postgres-mcp
# живуть у Docker всередині дистрибутива Ubuntu (не Docker Desktop).
#
#   powershell -File scripts/wsl/setup-docker-autostart.ps1          # встановити / оновити
#   powershell -File scripts/wsl/setup-docker-autostart.ps1 -Remove  # прибрати задачу
#
# Що робить:
#  1. кладе scripts/wsl/start-docker.sh у /usr/local/bin (LF, 755) і [boot] command у /etc/wsl.conf;
#  2. реєструє задачу планувальника «STO WSL Docker» (вхід користувача): `wsl.exe -u root
#     start-docker.sh` без вікна (conhost --headless). Відкритий wsl.exe тримає дистрибутив живим —
#     без systemd WSL гасить його разом із dockerd, щойно закривається остання сесія;
#  3. після `wsl --shutdown` задача завершується з помилкою і перезапускається щохвилини;
#  4. одразу запускає задачу.
# Права адміністратора не потрібні: задача — лише для поточного користувача.
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$taskName = 'STO WSL Docker'
$distro = 'Ubuntu'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Задачу «$taskName» прибрано. /usr/local/bin/start-docker.sh і [boot] лишились."
  exit 0
}

$src = Join-Path $PSScriptRoot 'start-docker.sh'
if (-not (Test-Path $src)) { throw "Немає $src" }
# Шлях у WSL: тека проєкту має пробіл («STO ERP»), тож через wslpath, а не конкатенацію.
$wslSrc = (& wsl.exe -d $distro -e wslpath -a ($src -replace '\\', '/')).Trim()

# CRLF з робочої копії Windows зламав би shebang — знімаємо \r під час копіювання.
& wsl.exe -d $distro -u root -e sh -c "tr -d '\r' < '$wslSrc' > /usr/local/bin/start-docker.sh && chmod 755 /usr/local/bin/start-docker.sh"
if ($LASTEXITCODE -ne 0) { throw 'Не вдалось встановити /usr/local/bin/start-docker.sh' }

$bootLine = 'command = /usr/local/bin/start-docker.sh'
$conf = (& wsl.exe -d $distro -u root -e sh -c 'cat /etc/wsl.conf 2>/dev/null') -join "`n"
if ($conf -notmatch [regex]::Escape($bootLine)) {
  Write-Host "УВАГА: у /etc/wsl.conf немає «$bootLine» у [boot] — додайте вручну (рядок [boot] уже може мати інший command)."
}

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
  -Argument "--headless wsl.exe -d $distro -u root -e /usr/local/bin/start-docker.sh"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description 'STO ERP: dockerd у WSL (scripts/wsl/start-docker.sh) і тримання дистрибутива живим' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
for ($i = 0; $i -lt 30; $i++) {
  # Через cmd: `docker info` пише в stderr попередження («No swap limit support»), і PowerShell 5.1
  # при ErrorActionPreference=Stop робить із нього виняток, хоча exit code 0.
  cmd /c "wsl.exe -d $distro -e docker info >nul 2>&1"
  if ($LASTEXITCODE -eq 0) { Write-Host "Docker у WSL працює; задача «$taskName» зареєстрована."; exit 0 }
  Start-Sleep -Seconds 1
}
throw "Docker не відповів за 30 с — дивіться /var/log/dockerd.log у WSL"
