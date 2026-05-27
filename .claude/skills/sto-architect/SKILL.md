---
name: sto-architect
description: >
  Architecture decision records, system design, and technical decisions for STO ERP. Use when the user says "як краще архітектурно", "яке технічне рішення", "ADR", "вибір технології", "як реалізувати sync", "installer", or faces an architectural choice. Produces structured ADR saved to docs/architecture/.
model: claude-opus-4-7
---

# sto-architect — Architecture Decision Skill

## Core Principles (НЕЗМІННІ)

1. **Offline-first** — система повністю функціонує без інтернету
2. **Local deployment** — Docker Compose на Windows ПК/сервері СТО
3. **Windows installer** — розповсюдження через .exe, не хмарний SaaS
4. **Tenant isolation** — `orgId` на кожній таблиці, кожному запиті
5. **Append-only для фінансів** — StockMovement, SettlementTransaction незмінні
6. **External API через чергу** — BullMQ retry при offline
7. **Sync-ready з дня першого** — `syncVersion`, `deletedAt` для майбутнього cloud

---

## ADR Template

```markdown
# ADR-{N}: {Назва}

**Дата:** YYYY-MM-DD
**Статус:** Запропоновано | Прийнято | Застаріло
**Контекст:** Чому це рішення потрібно прийняти?
**Драйвери:**
  - офлайн-незалежність
  - простота встановлення для нетехнічного персоналу
  - ...

## Розглянуті варіанти

### Варіант A: {Назва}
**Плюси:** ...
**Мінуси:** ...
**Зусилля:** S/M/L

### Варіант B: {Назва}
**Плюси:** ...
**Мінуси:** ...
**Зусилля:** S/M/L

## Рішення
**Обрано:** Варіант X
**Обґрунтування:** ...
**Наслідки:** ...
**Тригер перегляду:** (коли переглянути рішення)
```

Зберігати в: `docs/architecture/ADR-{N}-{slug}.md`

---

## Прийняті рішення (summary)

### ADR-001: Local-First Offline Architecture ✅
Система повністю функціонує без інтернету. Docker Compose запускає всі сервіси локально. Cloud — опція, не залежність.

### ADR-002: Docker Compose як одиниця розгортання ✅
Один `docker-compose.yml` описує весь production-стек. Встановлюється через Windows installer. Оновлення через `docker compose pull && docker compose up -d`.

### ADR-003: Inno Setup + PowerShell для Windows installer ✅
Inno Setup пакує все в один `.exe`. PowerShell-скрипти — логіка встановлення, оновлення, резервного копіювання. Docker images бандлюються як `.tar.gz` (CI-артефакти).

### ADR-004: WatermelonDB для offline-mobile ✅
Планшети механіків у боксах мають слабкий WiFi. WatermelonDB (SQLite) кешує наряди локально. Sync з основним API при відновленні з'єднання.

### ADR-005: BullMQ черга для зовнішніх API ✅
SMS, ПРРО (Checkbox), прайси постачальників — через BullMQ з Redis. При offline завдання зберігається в черзі, retry при відновленні. Гарантована доставка.

### ADR-006: Outbox Pattern для cloud-sync (опц.) ✅
Кожна транзакція пише запис в `event_outbox`. BullMQ worker кожні 30с пушить в Cloud Sync Hub. Conflict resolution: last-write-wins по `updated_at` + vector clocks для WO.

---

## Installer Architecture

```
installer/
├── inno/
│   ├── setup.iss           ← головний Inno Setup скрипт
│   └── uninstall.iss
├── scripts/
│   ├── install.ps1         ← перевірка вимог, Docker setup, compose up
│   ├── update.ps1          ← docker compose pull + rolling restart
│   ├── backup.ps1          ← pg_dump + minio sync → зашифрований архів
│   └── restore.ps1
├── assets/
│   ├── icon.ico
│   ├── splash.bmp
│   └── license_uk.txt
└── bundle/                 ← CI-generated, gitignored
    ├── docker-desktop-installer.exe
    ├── images/
    │   ├── sto-api.tar.gz
    │   ├── sto-web.tar.gz
    │   ├── postgres-16.tar.gz
    │   ├── redis-7.tar.gz
    │   └── minio.tar.gz
    └── vcredist_x64.exe    ← Visual C++ runtime
```

### Installer Flow
```
Користувач запускає STO-ERP-Setup-v1.0.0.exe
  ↓
1. UAC elevation (адмін-права)
2. Перевірка: Windows 10/11 64-bit, RAM ≥ 8GB, диск ≥ 20GB
3. Встановлення Docker Desktop (якщо відсутній) → перезавантаження
4. Увімкнення WSL2 + Hyper-V (PowerShell)
5. Завантаження Docker images з bundle/ (docker load < image.tar.gz)
6. Копіювання docker-compose.yml + .env у C:\ProgramData\STO-ERP\
7. docker compose up -d
8. Очікування health checks (postgres, api, web)
9. Перший запуск: seed базових даних + création адмін-акаунту
10. Реєстрація Windows Service "STO ERP" (NSSM)
11. Створення ярлика на робочому столі → http://sto.local
12. Відкриття браузера → сторінка першого входу
```

---

## Scalability Path

| Фаза | Масштаб | Архітектура |
|------|---------|-------------|
| MVP | 1 філія, 1-10 юзерів | Docker Compose, без cloud |
| v1.1 | 1 філія + cloud backup | Outbox sync, cloud S3 бекап |
| v2 | Multi-branch (2-10 СТО) | Cloud Hub + консолідація |
| v3 | SaaS-модель | Cloud-only варіант для малих СТО |

---

## Коли використовувати цей скіл

- Вибір між 2+ підходами реалізації
- Нова зовнішня інтеграція (ПРРО, SMS, постачальник)
- Зміна в deployment/installer pipeline
- Планування cloud-sync фічі
- Будь-яке рішення, яке важко відкатити

Результат: ADR файл у `docs/architecture/ADR-{N}-{slug}.md`
