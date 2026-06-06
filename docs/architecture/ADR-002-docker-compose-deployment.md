# ADR-002: Docker Compose як одиниця розгортання

**Дата:** 2026-05-22  
**Оновлено:** 2026-06-05  
**Статус:** Прийнято

## Контекст

Потрібно розгорнути стек з 6 сервісів (API, Web, PostgreSQL, Redis, MinIO, Proxy) на Windows-машині СТО без IT-спеціаліста. Рішення повинно бути відтворюваним, ізольованим і простим в оновленні.

## Розглянуті варіанти

### Варіант A: Нативне встановлення (Node.js + PostgreSQL прямо в Windows)

**Мінуси:** Конфлікти версій, складний деінсталятор, "works on my machine", ручне оновлення кожного компонента окремо

### Варіант B: Kubernetes (k3s або minikube)

**Мінуси:** Надмірна складність для одного сервера, великий overhead пам'яті, непотрібна надлишковість

### Варіант C: Docker Desktop + Compose

**Плюси:** Простий GUI, офіційна підтримка Windows  
**Мінуси:** Комерційна ліцензія (платна для бізнесу > 250 чол.), тяжкий (600 MB+), займає системні ресурси навіть коли не потрібен, нестабільний при системних оновленнях Windows

### Варіант D: Docker Engine у WSL2 + Compose ✅

**Плюси:**

- Безкоштовний, без ліцензійних обмежень
- Native Linux docker — більш стабільний і легший ніж Docker Desktop
- Volumes живуть в WSL2 filesystem (`/var/lib/docker/volumes/`) — швидкий I/O
- Автозапуск через `/etc/wsl.conf [boot]` без зовнішніх service managers
- Port forwarding через Windows `netsh portproxy` — порти доступні на `localhost`
- WSL2 монтує Windows диски (`/mnt/e`) — код на E: доступний з контейнерів

## Рішення: Docker Engine у WSL2 + Compose

### Конфігурація середовища розробки

**WSL2 `/etc/wsl.conf`** — автозапуск dockerd при старті WSL2:

```ini
[boot]
command = /usr/local/bin/start-docker.sh
```

**`/usr/local/bin/start-docker.sh`** — wrapper з повним PATH:

```bash
#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
exec /usr/bin/dockerd >> /var/log/dockerd.log 2>&1
```

**`/etc/docker/daemon.json`** — увімкнений userland-proxy для port forwarding:

```json
{ "userland-proxy": true }
```

**Windows port proxy** (виконується як Administrator при першому налаштуванні):

```powershell
$wslIp = (wsl -- hostname -I).Split(' ')[0].Trim()
netsh interface portproxy add v4tov4 listenport=5432 listenaddress=127.0.0.1 connectport=5432 connectaddress=$wslIp
netsh interface portproxy add v4tov4 listenport=6379 listenaddress=127.0.0.1 connectport=6379 connectaddress=$wslIp
netsh interface portproxy add v4tov4 listenport=9000 listenaddress=127.0.0.1 connectport=9000 connectaddress=$wslIp
netsh interface portproxy add v4tov4 listenport=9001 listenaddress=127.0.0.1 connectport=9001 connectaddress=$wslIp
```

> **Gotcha — WSL2 IP змінюється при перезапуску.** Port proxy потрібно оновлювати після кожного `wsl --shutdown`. Рішення для production installer: PowerShell скрипт у Task Scheduler, що автоматично оновлює proxy при старті Windows.

> **Gotcha — BitLocker диск E:.** При старті Windows WSL2 може ініціалізуватись до того як BitLocker розблокує зашифровані диски. Docker volumes (`/var/lib/docker/volumes/`) зберігаються в WSL2 filesystem і не залежать від E: — контейнери стартують нормально. Команда `docker compose up` потребує доступу до `docker-compose.yml` на E: — виконувати тільки після повного розблокування диску.

> **Gotcha — Ubuntu 26.04 (resolute).** Docker не має пакетів для нового релізу Ubuntu. При встановленні використовувати репозиторій `noble` (24.04) — сумісний.

### Production docker-compose.yml

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${POSTGRES_USER}']
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']

  minio:
    image: minio/minio
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ACCESS_KEY}
      MINIO_ROOT_PASSWORD: ${MINIO_SECRET_KEY}
    volumes:
      - minio_data:/data
    healthcheck:
      # minio не має curl/wget — використовувати mc ready
      test: ['CMD', 'mc', 'ready', 'local']
      interval: 15s
      timeout: 5s
      retries: 5

  api:
    image: ghcr.io/your-org/sto-api:${VERSION:-latest}
    restart: unless-stopped
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
      minio: { condition: service_healthy }
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      MINIO_ENDPOINT: minio
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET}
      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET}
      NODE_ENV: production
      TZ: Europe/Kyiv
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:3000/health']
      interval: 30s
      start_period: 60s

  web:
    image: ghcr.io/your-org/sto-web:${VERSION:-latest}
    restart: unless-stopped
    depends_on:
      api: { condition: service_healthy }

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    depends_on:
      - web
      - api

volumes:
  postgres_data:
  redis_data:
  minio_data:
  caddy_data:
```

### Caddyfile (local HTTPS)

```
sto.local {
  tls internal
  reverse_proxy /api/* api:3000
  reverse_proxy /* web:80
}
```

### Запуск середовища розробки

```bash
# 1. WSL2 (відкрити термінал — dockerd стартує автоматично)
# 2. Перевірити контейнери
docker ps

# 3. Якщо контейнери не запущені
docker compose -f "/mnt/e/Git/STO ERP/docker-compose.dev.yml" up -d

# 4. API (термінал 1)
pnpm --filter @sto/api dev

# 5. Web (термінал 2)
pnpm --filter @sto/web dev
```

### Стратегія оновлення

1. `Update.ps1` — контрольоване оновлення з міграцією БД (детально в ADR-007)
2. Rolling restart: зупинити api → мігрувати БД → запустити нові api + web

## Наслідки

- Розмір bundle: ~1.5-2 GB (образи без Docker Desktop)
- RAM під час роботи: ~1.5-2 GB (весь стек)
- Час холодного старту WSL2 + dockerd: ~15-20 секунд
- Час старту контейнерів після dockerd: ~10-15 секунд
- Оновлення: ~5 хвилин без простою для клієнтів
- Docker Desktop більше не потрібен — знімається ліцензійне обмеження
