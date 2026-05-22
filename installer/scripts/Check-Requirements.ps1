#Requires -RunAsAdministrator
param()

Add-Type -AssemblyName System.Windows.Forms
$errors = @()

# Windows version (min 10.0.17763 = 1809)
$os = [System.Environment]::OSVersion.Version
if ($os.Major -lt 10 -or ($os.Major -eq 10 -and $os.Build -lt 17763)) {
    $errors += "Потрібна Windows 10 версії 1809 або новіша (поточна: $($os))"
}

# 64-bit OS
if (-not [System.Environment]::Is64BitOperatingSystem) {
    $errors += "Потрібна 64-бітна операційна система"
}

# RAM >= 8 GB
$ramGB = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB
if ($ramGB -lt 7.5) {
    $errors += "Потрібно мінімум 8 ГБ ОЗП (доступно: $([math]::Round($ramGB, 1)) ГБ)"
}

# Disk >= 20 GB free on system drive
$sysDrive = $env:SystemDrive -replace '\\', ''
$freeGB   = (Get-PSDrive ($sysDrive -replace ':','') -ErrorAction SilentlyContinue).Free / 1GB
if ($null -eq $freeGB -or $freeGB -lt 20) {
    $errors += "Потрібно мінімум 20 ГБ вільного місця на диску C: (доступно: $([math]::Round($freeGB, 1)) ГБ)"
}

# Virtualization enabled
$virt = (Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue).VirtualizationFirmwareEnabled
if ($virt -eq $false) {
    $errors += "Увімкніть апаратну віртуалізацію (Intel VT-x або AMD-V) у налаштуваннях BIOS/UEFI"
}

if ($errors.Count -gt 0) {
    $msg = "Системні вимоги не виконані:`n`n" + ($errors -join "`n`n")
    [System.Windows.Forms.MessageBox]::Show(
        $msg, "STO ERP — Системні вимоги", "OK", "Error"
    ) | Out-Null
    exit 1
}

exit 0
