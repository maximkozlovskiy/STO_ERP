# STO ERP — Довідник змінних середовища

> Всі змінні для всіх додатків. Оновлювати при додаванні нових сервісів.  
> **Ніколи не комітити реальні значення** — тільки `.env.example` у репозиторій.

---

## Зміст

- [apps/api](#appsapi)
- [apps/web](#appsweb)
- [apps/mobile](#appsmobile)
- [packages/database](#packagesdatabase)
- [Docker Compose / інфраструктура](#docker-compose)
- [Шаблони .env.example](#шаблони)

---

## apps/api

| Змінна | Тип | Обов'язкова | За замовч. | Опис |
|--------|-----|-------------|------------|------|
| `NODE_ENV` | `development\|production\|test` | ✅ | `development` | Режим запуску |
| `PORT` | number | ❌ | `3000` | HTTP порт API |
| `API_PREFIX` | string | ❌ | `api` | Префікс всіх маршрутів |
| **База даних** | | | | |
| `DATABASE_URL` | string | ✅ | — | PostgreSQL connection string: `postgresql://USER:PASS@HOST:PORT/DB` |
| **Redis** | | | | |
| `REDIS_URL` | string | ✅ | — | Redis connection: `redis://HOST:PORT` |
| `REDIS_PASSWORD` | string | ❌ | — | Пароль Redis (якщо встановлено) |
| **JWT** | | | | |
| `JWT_ACCESS_SECRET` | string | ✅ | — | Секрет access токена (мін. 32 символи) |
| `JWT_REFRESH_SECRET` | string | ✅ | — | Секрет refresh токена (мін. 32 символи) |
| `JWT_ACCESS_EXPIRES_IN` | string | ❌ | `15m` | TTL access токена (формат: `15m`, `1h`) |
| `JWT_REFRESH_EXPIRES_IN` | string | ❌ | `30d` | TTL refresh токена |
| **ПРРО (Checkbox)** — ⚠️ переїхало в `BranchSettings` | | | | |
| `CHECKBOX_API_URL` | string | ❌ | `https://api.checkbox.in.ua/api/v1` | Fallback якщо `BranchSettings.checkboxApiUrl` не заповнено |
| ~~`CHECKBOX_LICENSE_KEY`~~ | — | ❌ | — | **Зберігається в `BranchSettings.checkboxLicenseKey` (зашифровано)** |
| ~~`CHECKBOX_PIN_CODE`~~ | — | ❌ | — | **Зберігається в `BranchSettings.checkboxPinCode` (зашифровано)** |
| ~~`CHECKBOX_CASH_REGISTER_ID`~~ | — | ❌ | — | **Зберігається в `BranchSettings.checkboxCashRegisterId`** |
| **SMS** — ⚠️ переїхало в `BranchSettings` | | | | |
| ~~`SMS_PROVIDER`~~ | — | ❌ | — | **Зберігається в `BranchSettings.smsProvider`** |
| ~~`TURBOSMS_TOKEN`~~ | — | ❌ | — | **Зберігається в `BranchSettings.smsApiKey` (зашифровано)** |
| ~~`TURBOSMS_SENDER`~~ | — | ❌ | — | **Зберігається в `BranchSettings.smsSenderName`** |
| ~~`ALPHASMS_LOGIN`~~ | — | ❌ | — | **Зберігається в `BranchSettings.smsApiKey`** |
| ~~`ALPHASMS_PASSWORD`~~ | — | ❌ | — | **Зберігається в `BranchSettings.smsApiKey`** |
| **MinIO (файли)** | | | | |
| `MINIO_ENDPOINT` | string | ✅ | `localhost` | MinIO host |
| `MINIO_PORT` | number | ❌ | `9000` | MinIO порт |
| `MINIO_USE_SSL` | boolean | ❌ | `false` | SSL для MinIO (true у production) |
| `MINIO_ACCESS_KEY` | string | ✅ | — | MinIO access key |
| `MINIO_SECRET_KEY` | string | ✅ | — | MinIO secret key |
| `MINIO_BUCKET` | string | ❌ | `sto-erp` | Назва bucket |
| **Шифрування налаштувань** | | | | |
| `SETTINGS_ENCRYPTION_KEY` | string | ✅ | — | AES-256 ключ для шифрування секретів в БД (ПРРО PIN, SMS ключі). Мін. 32 символи |
| **Cloud Sync (опційно)** | | | | |
| `CLOUD_SYNC_ENABLED` | boolean | ❌ | `false` | Вмикає cloud sync |
| `CLOUD_SYNC_API_URL` | string | якщо sync | — | URL хмарного sync-сервера |
| `CLOUD_SYNC_API_KEY` | string | якщо sync | — | API ключ для синхронізації |
| `CLOUD_SYNC_INTERVAL_MS` | number | ❌ | `300000` | Інтервал sync в мс (5 хв) |
| **BullMQ** | | | | |
| `QUEUE_FISCAL_ATTEMPTS` | number | ❌ | `288` | Кількість спроб ПРРО (288 = 24год по 5 хв) |
| `QUEUE_SMS_ATTEMPTS` | number | ❌ | `5` | Кількість спроб SMS |
| **Логування** | | | | |
| `LOG_LEVEL` | `error\|warn\|log\|debug\|verbose` | ❌ | `log` | Рівень логів |
| `LOG_DIR` | string | ❌ | `./logs` | Директорія для файлів логів |

---

## apps/web

| Змінна | Тип | Обов'язкова | За замовч. | Опис |
|--------|-----|-------------|------------|------|
| `NEXT_PUBLIC_API_URL` | string | ✅ | `http://localhost:3000/api` | URL бекенду (публічна) |
| `NEXT_PUBLIC_APP_NAME` | string | ❌ | `STO ERP` | Назва застосунку в UI |
| `NEXT_PUBLIC_VERSION` | string | ❌ | — | Версія застосунку (з CI) |

> Web-додаток компілюється як статичний export (`next build && next export`). Всі `NEXT_PUBLIC_*` змінні вбудовуються під час збірки.

---

## apps/mobile

| Змінна | Тип | Обов'язкова | За замовч. | Опис |
|--------|-----|-------------|------------|------|
| `EXPO_PUBLIC_API_URL` | string | ✅ | `http://192.168.1.X:3000/api` | URL API (LAN адреса сервера) |
| `EXPO_PUBLIC_APP_VERSION` | string | ❌ | — | Версія для відображення |
| `EXPO_PUBLIC_SENTRY_DSN` | string | ❌ | — | Sentry DSN для crash reporting |

> **Важливо:** на планшеті механіка `EXPO_PUBLIC_API_URL` має бути LAN IP сервера, не `localhost`.

---

## packages/database

| Змінна | Тип | Обов'язкова | Опис |
|--------|-----|-------------|------|
| `DATABASE_URL` | string | ✅ | PostgreSQL connection string (та сама що в api) |

---

## Docker Compose

Змінні для `docker-compose.yml` — зберігаються у `.env` в корені проекту:

| Змінна | За замовч. | Опис |
|--------|------------|------|
| `POSTGRES_USER` | `sto` | Користувач PostgreSQL |
| `POSTGRES_PASSWORD` | — | Пароль PostgreSQL (генерується інсталятором) |
| `POSTGRES_DB` | `sto_erp` | Назва бази даних |
| `POSTGRES_PORT` | `5432` | Зовнішній порт PostgreSQL |
| `REDIS_PORT` | `6379` | Зовнішній порт Redis |
| `REDIS_PASSWORD` | — | Пароль Redis |
| `MINIO_ROOT_USER` | `minioadmin` | MinIO root user |
| `MINIO_ROOT_PASSWORD` | — | MinIO root password (генерується) |
| `MINIO_PORT` | `9000` | MinIO API порт |
| `MINIO_CONSOLE_PORT` | `9001` | MinIO Console порт |
| `API_PORT` | `3000` | Зовнішній порт API |
| `WEB_PORT` | `3001` | Зовнішній порт Web |

---

## Шаблони

### `apps/api/.env.example`

```bash
# === Середовище ===
NODE_ENV=development
PORT=3000

# === База даних ===
DATABASE_URL=postgresql://sto:CHANGE_ME@localhost:5432/sto_erp

# === Redis ===
REDIS_URL=redis://localhost:6379
# REDIS_PASSWORD=CHANGE_ME

# === JWT (генерувати: openssl rand -base64 32) ===
JWT_ACCESS_SECRET=CHANGE_ME_32_CHARS_MIN
JWT_REFRESH_SECRET=CHANGE_ME_32_CHARS_MIN

# === ПРРО Checkbox ===
# Налаштовується через UI у BranchSettings (per branch)
# Fallback API URL якщо не вказано в BranchSettings:
CHECKBOX_API_URL=https://api.checkbox.in.ua/api/v1

# === SMS ===
# Налаштовується через UI у BranchSettings (provider, api_key, sender)
# Encryption key для секретів в БД (ОБОВ'ЯЗКОВО):
SETTINGS_ENCRYPTION_KEY=CHANGE_ME_32_CHARS_MIN

# === MinIO ===
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=CHANGE_ME
MINIO_BUCKET=sto-erp

# === Cloud Sync (вимкнено за замовч.) ===
CLOUD_SYNC_ENABLED=false
# CLOUD_SYNC_API_URL=https://sync.sto-erp.ua/api
# CLOUD_SYNC_API_KEY=CHANGE_ME

# === Черги ===
QUEUE_FISCAL_ATTEMPTS=288
QUEUE_SMS_ATTEMPTS=5

# === Логи ===
LOG_LEVEL=log
LOG_DIR=./logs
```

### `.env.example` (корінь, для Docker)

```bash
# PostgreSQL
POSTGRES_USER=sto
POSTGRES_PASSWORD=CHANGE_ME
POSTGRES_DB=sto_erp
POSTGRES_PORT=5432

# Redis
REDIS_PORT=6379
REDIS_PASSWORD=CHANGE_ME

# MinIO
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=CHANGE_ME
MINIO_PORT=9000
MINIO_CONSOLE_PORT=9001

# Ports
API_PORT=3000
WEB_PORT=3001
```

---

## Генерація секретів (при інсталяції)

```powershell
# Setup-Stack.ps1 генерує автоматично:
$jwtAccess = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
$jwtRefresh = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
$postgresPassword = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$redisPassword = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$minioPassword = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
```

