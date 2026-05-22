# ADR-003: Inno Setup + PowerShell для Windows Installer

**Дата:** 2026-05-22
**Статус:** Прийнято

## Контекст

Потрібно надати механізм встановлення STO ERP на Windows ПК/сервер СТО без участі розробника. Цільова аудиторія — власник або адміністратор СТО, нетехнічна людина. Installer повинен: встановити Docker, завантажити образи, налаштувати стек, запустити сервіси.

## Вимоги

- Один `.exe` файл, все включено (offline)
- Розмір ≤ 3 GB (стиснений)
- Встановлення ≤ 15 хвилин
- Зрозумілий UI українською мовою
- Підтримка тихого встановлення (`/VERYSILENT`)
- Деінсталяція без слідів (крім даних)

## Розглянуті варіанти

### Варіант A: NSIS (Nullsoft Scriptable Install System)
**Плюси:** Дуже гнучкий, малий розмір installer runtime
**Мінуси:** Застарілий синтаксис, складна відладка, слабка підтримка Unicode

### Варіант B: WiX Toolset (MSI)
**Плюси:** Enterprise-рівень, повна підтримка Windows Installer
**Мінуси:** Надмірна складність для нашого випадку, MSI погано підходить для "запустити docker compose"

### Варіант C: Electron-based Launcher
**Плюси:** Красивий GUI, cross-platform, можна зробити tray-app для моніторингу
**Мінуси:** +200MB тільки на Electron runtime, складніший білд-пайплайн

### Варіант D: Inno Setup + PowerShell ✅
**Плюси:**
- Зрілий інструмент (з 1997, активно підтримується)
- Відмінна підтримка Unicode / кирилиці
- Вбудований стиснення LZMA2
- PowerShell — нативний Windows, немає зовнішніх залежностей
- Легко додати прогрес-бар, вибір директорії, компоненти
- Безкоштовний

**Мінуси:** Немає GUI-моніторингу після встановлення (вирішується окремим tray-app у Phase 3)

## Рішення: Inno Setup + PowerShell

### Структура installer
```
STO-ERP-Setup-v1.0.0.exe  (~2.5 GB стиснений)
  ├── Inno Setup runtime (UI, прогрес, вибір опцій)
  ├── docker-desktop-installer.exe  (~600 MB)
  ├── Docker images (*.tar.gz):
  │     sto-api.tar.gz      (~200 MB)
  │     sto-web.tar.gz      (~50 MB)
  │     postgres-16.tar.gz  (~80 MB)
  │     redis-7.tar.gz      (~15 MB)
  │     minio.tar.gz        (~150 MB)
  │     caddy.tar.gz        (~20 MB)
  ├── nssm.exe (Windows Service manager)
  ├── PowerShell scripts
  └── docker-compose.yml + Caddyfile
```

### Кроки встановлення (що бачить користувач)
```
[1/6] Перевірка системних вимог...   ~5 сек
[2/6] Встановлення Docker...         ~3 хв (якщо потрібно)
[3/6] Завантаження компонентів...    ~5 хв (docker load)
[4/6] Налаштування STO ERP...        ~2 хв
[5/6] Перший запуск...               ~1 хв
[6/6] Готово!                        → відкрити браузер
```

### Автозапуск як Windows Service
```powershell
# nssm встановлює "STO ERP" як службу Windows
nssm install "STO ERP" docker
nssm set "STO ERP" AppParameters "compose -f C:\ProgramData\STO-ERP\docker-compose.yml up"
nssm set "STO ERP" AppDirectory "C:\ProgramData\STO-ERP"
nssm set "STO ERP" Start SERVICE_AUTO_START
nssm start "STO ERP"
```

## Наслідки

- Білд installer вимагає CI з Windows runner (GitHub Actions `windows-latest`)
- Images бандлюються в CI і не зберігаються в git (`.gitignore: installer/bundle/`)
- Тихе встановлення: `STO-ERP-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES`
- Оновлення через `Update.ps1` (не потрібно перевстановлювати)
