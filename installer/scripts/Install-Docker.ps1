#Requires -RunAsAdministrator
param(
    [string]$BundlePath = "$env:TEMP\sto-erp-bundle"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log { param([string]$msg) Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" }

# Check if Docker is already installed and running
$dockerExe = Get-Command docker -ErrorAction SilentlyContinue
if ($dockerExe) {
    $info = docker info 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Log "Docker вже встановлено і запущено — пропускаємо встановлення."
        exit 0
    }
}

# Enable WSL2
Write-Log "Увімкнення WSL2..."
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart 2>$null
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart 2>$null
wsl --set-default-version 2 2>$null

# Run bundled Docker Desktop installer
$installer = Join-Path $BundlePath 'docker-desktop-installer.exe'
if (-not (Test-Path $installer)) {
    throw "Docker Desktop installer не знайдено: $installer"
}

Write-Log "Встановлення Docker Desktop (це може зайняти 5-10 хвилин)..."
Start-Process -FilePath $installer -ArgumentList 'install', '--quiet', '--accept-license', '--no-desktop-shortcut' -Wait

# Wait for Docker daemon to be ready
Write-Log "Очікування запуску Docker Engine..."
$maxWait = 120; $elapsed = 0
while ($elapsed -lt $maxWait) {
    Start-Sleep 5; $elapsed += 5
    $ready = (docker info 2>$null) -and ($LASTEXITCODE -eq 0)
    if ($ready) { break }
    Write-Log "  Очікування... ($elapsed / $maxWait сек)"
}

if (-not $ready) {
    throw "Docker не запустився за $maxWait секунд. Можливо, потрібен перезапуск Windows."
}

Write-Log "Docker Desktop успішно встановлено."
exit 0
