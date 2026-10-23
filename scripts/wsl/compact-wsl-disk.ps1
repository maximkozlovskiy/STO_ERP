# Стискання диска WSL (ext4.vhdx дистрибутива Ubuntu), коли він розрісся.
#
# Sparse-режим для цього дистрибутива вимкнено, тож vhdx лише росте: місце, звільнене всередині WSL
# (образи, кеш збірки, бази), назад Windows не повертається. Процедура — та сама, що 2026-10-23 вручну:
# почистити Docker → зупинити WSL → Optimize-VHD.
#
#   powershell -File scripts/wsl/compact-wsl-disk.ps1            # PowerShell від АДМІНІСТРАТОРА
#   powershell -File scripts/wsl/compact-wsl-disk.ps1 -Force     # без питання перед `wsl --shutdown`
#
# УВАГА: `wsl --shutdown` зупиняє ВСЕ у WSL — dev-стек (postgres/redis/minio), dev-сервери, E2E,
# postgres-mcp інших сесій Claude. Запускати, коли нічого з цього не працює.
# Docker чиститься обережно: зупинені контейнери, кеш збірки, образи без тегу. Образи з тегом і томи
# (дані dev-бази) — НЕ чіпаються: офлайн їх не завантажити заново.
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$distro = 'Ubuntu'
$taskName = 'STO WSL Docker'

# Нативна команда у WSL: Docker пише попередження в stderr, а PowerShell 5.1 при
# ErrorActionPreference=Stop робить із нього виняток. Аргументи — без вкладених подвійних лапок
# (5.1 їх не екранує для нативних програм).
function Invoke-Wsl([string[]]$WslArgs) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & wsl.exe @WslArgs 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $prev }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Optimize-VHD потребує прав адміністратора — запустіть PowerShell від адміністратора' }
if (-not (Get-Command Optimize-VHD -ErrorAction SilentlyContinue)) {
  throw 'Немає Optimize-VHD (модуль Hyper-V): Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-Management-PowerShell'
}

$reg = Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss |
  ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DistributionName -eq $distro }
if (-not $reg) { throw "Дистрибутив $distro не знайдено в реєстрі WSL" }
$vhdx = Join-Path $reg.BasePath 'ext4.vhdx'
$before = (Get-Item $vhdx).Length
Write-Host ("vhdx: {0} — {1:N1} ГБ" -f $vhdx, ($before / 1GB))

# Питання — ДО чистки Docker: «ні» не має лишати вже видалені зупинені контейнери й кеш збірки.
if (-not $Force) {
  $answer = Read-Host 'Почистити Docker і зупинити WSL (wsl --shutdown) — усе у WSL буде зупинено. Продовжити? [y/N]'
  if ($answer -notmatch '^(y|т|так|yes)$') { Write-Host 'Скасовано.'; exit 1 }
}

Write-Host 'Docker: зупинені контейнери, кеш збірки, образи без тегу…'
Invoke-Wsl @('-d', $distro, '-e', 'sh', '-c', 'docker container prune -f; docker builder prune -af; docker image prune -f')
# Звільнені блоки ext4 позначаються як вільні для vhdx лише після TRIM.
Invoke-Wsl @('-d', $distro, '-u', 'root', '-e', 'fstrim', '-av')

# Задача «STO WSL Docker» після `wsl --shutdown` за хвилину стартує знову (тригер-повтор) і підняла б WSL —
# посеред Optimize-VHD, коли vhdx зайнятий. Тому на час стискання вона вимкнена.
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) { Stop-ScheduledTask -TaskName $taskName; Disable-ScheduledTask -TaskName $taskName | Out-Null }
try {
  wsl.exe --shutdown
  Start-Sleep -Seconds 5
  Optimize-VHD -Path $vhdx -Mode Full
  $after = (Get-Item $vhdx).Length
  Write-Host ("Готово: {0:N1} ГБ → {1:N1} ГБ" -f ($before / 1GB), ($after / 1GB))
} finally {
  if ($task) {
    Enable-ScheduledTask -TaskName $taskName | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Host "Задачу «$taskName» увімкнено й запущено — Docker підніметься за кілька секунд."
  }
}
