---
name: sto-installer
description: >
  Build and maintain the Windows installer for STO ERP. Use when the user says "зроби інсталятор", "installer", "setup.exe", "розповсюдження", "встановлення на клієнта", "оновлення", "бекап", or working on installer/ directory. Covers: Inno Setup scripts, PowerShell automation, Docker image bundling, CI/CD pipeline for releases.
model: claude-sonnet-5
bypassPermissions: true
---

# sto-installer — Windows Installer Skill

## Мета

Створити `.exe` файл, який дозволяє нетехнічному персоналу встановити STO ERP на звичайний ПК або сервер під Windows без будь-яких знань про Docker, Node.js або командний рядок.

**Вимоги до installer:**

- Один файл `.exe`, все включено (offline-ready)
- Повне встановлення ≤ 15 хвилин
- Не потребує інтернету після завантаження installer
- Підтримка тихого встановлення (`/SILENT /VERYSILENT`)
- Автоматичне оновлення без перевстановлення

---

## Структура `installer/`

```
installer/
├── inno/
│   ├── setup.iss               ← Inno Setup головний скрипт
│   ├── components.iss          ← компонентна логіка
│   └── messages_uk.isl         ← українські рядки UI
├── scripts/
│   ├── Check-Requirements.ps1  ← перевірка системних вимог
│   ├── Install-Docker.ps1      ← встановлення Docker Desktop
│   ├── Setup-Stack.ps1         ← docker compose up + health check
│   ├── First-Run.ps1           ← seed даних, адмін-акаунт
│   ├── Update.ps1              ← оновлення без reinstall
│   ├── Backup.ps1              ← резервне копіювання
│   ├── Restore.ps1             ← відновлення з бекапу
│   └── Uninstall.ps1           ← чисте видалення
├── assets/
│   ├── icon.ico
│   ├── header.bmp              ← 497x55px
│   ├── wizard.bmp              ← 164x314px
│   └── license_uk.rtf
├── bundle/                     ← gitignored, CI-generated
│   ├── docker-desktop-installer.exe
│   ├── nssm.exe                ← Non-Sucking Service Manager
│   ├── vcredist_x64.exe
│   └── images/
│       ├── sto-api.tar.gz
│       ├── sto-web.tar.gz
│       ├── postgres-16.tar.gz
│       ├── redis-7.tar.gz
│       ├── minio.tar.gz
│       └── caddy.tar.gz
└── output/                     ← gitignored
    └── STO-ERP-Setup-v{VERSION}.exe
```

---

## Inno Setup Script (`setup.iss`)

```pascal
; installer/inno/setup.iss
#define AppName "STO ERP"
#define AppVersion "1.0.0"
#define AppPublisher "STO ERP"
#define AppURL "https://sto-erp.ua"
#define AppInstallDir "{commonpf64}\STO-ERP"
#define DataDir "{commonappdata}\STO-ERP"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
DefaultDirName={#AppInstallDir}
DefaultGroupName={#AppName}
OutputDir=..\output
OutputBaseFilename=STO-ERP-Setup-v{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
PrivilegesRequired=admin
MinVersion=10.0.17763  ; Windows 10 1809+
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
WizardStyle=modern
WizardSizePercent=120
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\icon.ico

; Splash screen
WizardImageFile=..\assets\wizard.bmp
WizardSmallImageFile=..\assets\header.bmp

[Languages]
Name: "ukrainian"; MessagesFile: ".\messages_uk.isl"

[Tasks]
Name: "desktopicon"; Description: "Створити ярлик на робочому столі"; GroupDescription: "Додаткові параметри:"
Name: "autostart"; Description: "Запускати STO ERP при старті Windows"; GroupDescription: "Додаткові параметри:"; Checked: yes

[Files]
; Docker images
Source: "..\bundle\images\*"; DestDir: "{tmp}\images"; Flags: deleteafterinstall
; Docker Desktop installer
Source: "..\bundle\docker-desktop-installer.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall
; NSSM for Windows Service
Source: "..\bundle\nssm.exe"; DestDir: "{app}\bin"
; Compose files and scripts
Source: "..\..\docker-compose.yml"; DestDir: "{#DataDir}"
Source: "..\scripts\*"; DestDir: "{app}\scripts"; Flags: recursesubdirs
; Assets
Source: "..\assets\icon.ico"; DestDir: "{app}"

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\STO ERP.url"; IconFilename: "{app}\icon.ico"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\STO ERP.url"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\Check-Requirements.ps1"""; Flags: runhidden; StatusMsg: "Перевірка системних вимог..."
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\Install-Docker.ps1"" -BundlePath ""{tmp}"""; Flags: runhidden; StatusMsg: "Встановлення Docker..."
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\Setup-Stack.ps1"" -DataDir ""{#DataDir}"" -ImagesDir ""{tmp}\images"""; Flags: runhidden; StatusMsg: "Розгортання STO ERP..."
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\First-Run.ps1"""; Flags: runhidden; StatusMsg: "Перший запуск..."

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\Uninstall.ps1"""; Flags: runhidden
```

---

## PowerShell: Check-Requirements.ps1

```powershell
# installer/scripts/Check-Requirements.ps1
param()

$errors = @()

# Windows version
$os = [System.Environment]::OSVersion.Version
if ($os.Major -lt 10 -or ($os.Major -eq 10 -and $os.Build -lt 17763)) {
    $errors += "Потрібна Windows 10 версії 1809 або новіша"
}

# Architecture
if ([System.Environment]::Is64BitOperatingSystem -eq $false) {
    $errors += "Потрібна 64-бітна операційна система"
}

# RAM
$ram = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB
if ($ram -lt 7.5) {
    $errors += "Потрібно мінімум 8 ГБ оперативної пам'яті (доступно: $([math]::Round($ram,1)) ГБ)"
}

# Disk space (C: drive)
$disk = (Get-PSDrive C).Free / 1GB
if ($disk -lt 20) {
    $errors += "Потрібно мінімум 20 ГБ вільного місця (доступно: $([math]::Round($disk,1)) ГБ)"
}

# Virtualization enabled
$virt = (Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled
if (-not $virt) {
    $errors += "Увімкніть апаратну віртуалізацію (VT-x/AMD-V) у BIOS"
}

if ($errors.Count -gt 0) {
    $msg = "Системні вимоги не виконані:`n`n" + ($errors -join "`n")
    [System.Windows.Forms.MessageBox]::Show($msg, "STO ERP — Помилка", "OK", "Error")
    exit 1
}

exit 0
```

---

## PowerShell: Setup-Stack.ps1

```powershell
# installer/scripts/Setup-Stack.ps1
param(
    [string]$DataDir = "C:\ProgramData\STO-ERP",
    [string]$ImagesDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Log { param([string]$msg) Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" }

# 1. Enable WSL2
Write-Log "Увімкнення WSL2..."
wsl --set-default-version 2 2>$null

# 2. Load Docker images from bundle
if ($ImagesDir -and (Test-Path $ImagesDir)) {
    Write-Log "Завантаження Docker образів..."
    Get-ChildItem "$ImagesDir\*.tar.gz" | ForEach-Object {
        Write-Log "  Завантаження $($_.Name)..."
        docker load -i $_.FullName
    }
}

# 3. Create data directory structure
New-Item -ItemType Directory -Force -Path @(
    $DataDir,
    "$DataDir\postgres",
    "$DataDir\redis",
    "$DataDir\minio",
    "$DataDir\backups"
) | Out-Null

# 4. Generate secrets
$jwtAccess  = [System.Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
$jwtRefresh = [System.Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
$pgPassword = [System.Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
$minioKey   = [System.Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24))

# 5. Write .env
@"
DATABASE_URL=postgresql://sto:${pgPassword}@postgres:5432/sto_erp
REDIS_URL=redis://redis:6379
MINIO_ENDPOINT=minio
MINIO_PORT=9000
MINIO_ACCESS_KEY=stoerp
MINIO_SECRET_KEY=${minioKey}
JWT_ACCESS_SECRET=${jwtAccess}
JWT_REFRESH_SECRET=${jwtRefresh}
POSTGRES_USER=sto
POSTGRES_PASSWORD=${pgPassword}
POSTGRES_DB=sto_erp
NODE_ENV=production
TZ=Europe/Kyiv
"@ | Set-Content "$DataDir\.env"

# 6. Docker Compose up
Write-Log "Запуск STO ERP..."
Set-Location $DataDir
docker compose --env-file .env up -d

# 7. Health checks
Write-Log "Перевірка готовності..."
$maxWait = 120; $waited = 0
do {
    Start-Sleep 5; $waited += 5
    $health = docker compose ps --format json | ConvertFrom-Json
    $allUp = ($health | Where-Object { $_.Health -ne "healthy" }).Count -eq 0
} while (-not $allUp -and $waited -lt $maxWait)

if (-not $allUp) {
    throw "Сервіси не запустились за $maxWait секунд. Перевірте логи: docker compose logs"
}

Write-Log "STO ERP успішно запущено!"
```

---

## PowerShell: Update.ps1

```powershell
# installer/scripts/Update.ps1
param([string]$DataDir = "C:\ProgramData\STO-ERP")

Set-Location $DataDir

Write-Host "Зупинка API і Web..."
docker compose stop api web

Write-Host "Завантаження нових образів..."
docker compose pull api web

Write-Host "Запуск міграцій БД..."
docker compose run --rm api pnpm prisma migrate deploy

Write-Host "Запуск нових контейнерів..."
docker compose up -d api web

Write-Host "Оновлення завершено!"
```

---

## PowerShell: Backup.ps1

```powershell
# installer/scripts/Backup.ps1
param(
    [string]$DataDir = "C:\ProgramData\STO-ERP",
    [string]$BackupDir = "C:\ProgramData\STO-ERP\backups"
)

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm"
$backupPath = "$BackupDir\backup_$timestamp"
New-Item -ItemType Directory -Force -Path $backupPath | Out-Null

# PostgreSQL dump
Write-Host "Резервне копіювання бази даних..."
docker compose -f "$DataDir\docker-compose.yml" exec -T postgres `
    pg_dump -U sto sto_erp | Set-Content "$backupPath\database.sql"

# MinIO files
Write-Host "Резервне копіювання файлів..."
docker compose -f "$DataDir\docker-compose.yml" exec -T minio `
    mc mirror /data "$backupPath\minio" 2>$null

# Compress
Compress-Archive -Path $backupPath -DestinationPath "$backupPath.zip"
Remove-Item $backupPath -Recurse

# Keep last 30 backups
Get-ChildItem $BackupDir -Filter "backup_*.zip" |
    Sort-Object CreationTime -Descending |
    Select-Object -Skip 30 |
    Remove-Item

Write-Host "Бекап збережено: $backupPath.zip"
```

---

## CI/CD Pipeline для Release

```yaml
# .github/workflows/release.yml
name: Build Installer

on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build Docker images
        run: |
          docker compose build
          docker save sto-api | gzip > installer/bundle/images/sto-api.tar.gz
          docker save sto-web | gzip > installer/bundle/images/sto-web.tar.gz

      - name: Pull base images
        run: |
          docker pull postgres:16-alpine
          docker save postgres:16-alpine | gzip > installer/bundle/images/postgres-16.tar.gz
          docker pull redis:7-alpine
          docker save redis:7-alpine | gzip > installer/bundle/images/redis-7.tar.gz
          docker pull minio/minio
          docker save minio/minio | gzip > installer/bundle/images/minio.tar.gz
          docker pull caddy:2-alpine
          docker save caddy:2-alpine | gzip > installer/bundle/images/caddy.tar.gz

      - name: Build Installer
        run: |
          choco install innosetup -y
          iscc installer/inno/setup.iss /DAppVersion=${{ github.ref_name }}

      - name: Upload Release
        uses: actions/upload-artifact@v4
        with:
          name: STO-ERP-Setup-${{ github.ref_name }}
          path: installer/output/*.exe
```

---

## Checklist перед релізом

- [ ] Всі Docker images зібрані і протестовані
- [ ] PowerShell скрипти протестовані на чистій Windows VM
- [ ] Тихе встановлення (`/VERYSILENT`) працює коректно
- [ ] Деінсталяція видаляє всі компоненти (крім даних)
- [ ] Версія у `setup.iss` і `package.json` збігаються
- [ ] Розмір installer ≤ 3 GB (стиснений)
- [ ] Перевірено на Windows 10 і Windows 11
