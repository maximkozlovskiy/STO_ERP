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
STO-ERP-Setup-v1.0.0.exe  (~2 GB стиснений)
  ├── Inno Setup runtime (UI, прогрес, вибір опцій)
  ├── wsl2-docker-install.sh  (встановлення Docker Engine у WSL2)
  ├── Docker images (*.tar.gz):
  │     sto-api.tar.gz      (~200 MB)
  │     sto-web.tar.gz      (~50 MB)
  │     postgres-16.tar.gz  (~80 MB)
  │     redis-7.tar.gz      (~15 MB)
  │     minio.tar.gz        (~150 MB)
  │     caddy.tar.gz        (~20 MB)
  ├── nssm.exe (Windows Service manager)
  ├── PowerShell scripts
  │     Setup-PortProxy.ps1  (netsh portproxy WSL2→Windows)
  │     Update-PortProxy.ps1 (оновлення IP після перезапуску)
  └── docker-compose.yml + Caddyfile
```

> **Важливо:** Docker Desktop більше НЕ bundлюється в installer.
> Натомість встановлюється Docker Engine нативно у WSL2 — безкоштовно, без ліцензійних обмежень. Детальніше в ADR-002.

### Кроки встановлення (що бачить користувач)

```
[1/6] Перевірка системних вимог...   ~5 сек
[2/6] Встановлення Docker...         ~3 хв (якщо потрібно)
[3/6] Завантаження компонентів...    ~5 хв (docker load)
[4/6] Налаштування STO ERP...        ~2 хв
[5/6] Перший запуск...               ~1 хв
[6/6] Готово!                        → відкрити браузер
```

### Автозапуск

Docker Engine стартує автоматично через WSL2 `/etc/wsl.conf`:

```ini
[boot]
command = /usr/local/bin/start-docker.sh
```

Контейнери підіймаються разом з WSL2 через `restart: unless-stopped` в `docker-compose.yml`.

Port proxy оновлюється при кожному старті Windows через Task Scheduler:

```powershell
# Update-PortProxy.ps1 — запускається при вході в систему
$wslIp = (wsl -- hostname -I).Split(' ')[0].Trim()
foreach ($port in @(80, 443, 5432, 6379, 9000, 9001)) {
  netsh interface portproxy delete v4tov4 listenport=$port listenaddress=127.0.0.1 2>$null
  netsh interface portproxy add v4tov4 listenport=$port listenaddress=127.0.0.1 connectport=$port connectaddress=$wslIp
}
```

## Наслідки

- Білд installer вимагає CI з Windows runner (GitHub Actions `windows-latest`)
- Images бандлюються в CI і не зберігаються в git (`.gitignore: installer/bundle/`)
- Тихе встановлення: `STO-ERP-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES`
- Оновлення через `Update.ps1` (не потрібно перевстановлювати)
- Docker Desktop не потрібен — installer на ~600 MB менший
- WSL2 повинен бути увімкнений (Windows 10 2004+ / Windows 11) — installer перевіряє і вмикає якщо потрібно
