# ADR-002: Docker Compose як одиниця розгортання

**Дата:** 2026-05-22
**Статус:** Прийнято

## Контекст

Потрібно розгорнути стек з 6 сервісів (API, Web, PostgreSQL, Redis, MinIO, Proxy) на Windows-машині СТО без IT-спеціаліста. Рішення повинно бути відтворюваним, ізольованим і простим в оновленні.

## Розглянуті варіанти

### Варіант A: Нативне встановлення (Node.js + PostgreSQL прямо в Windows)
**Мінуси:** Конфлікти версій, складний деінсталятор, "works on my machine", ручне оновлення кожного компонента окремо

### Варіант B: Kubernetes (k3s або minikube)
**Мінуси:** Надмірна складність для одного сервера, великий overhead пам'яті, непотрібна надлишковість

### Варіант C: Docker Compose ✅
**Плюси:** Один файл описує весь стек, ізоляція, легке оновлення (`docker compose pull && up -d`), стандарт для on-prem, добре підтримується на Windows через Docker Desktop

## Рішення: Docker Compose

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
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
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
      test: ["CMD", "redis-cli", "ping"]

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
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]

  api:
    image: ghcr.io/your-org/sto-api:${VERSION:-latest}
    restart: unless-stopped
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_healthy }
      minio:    { condition: service_healthy }
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      MINIO_ENDPOINT: minio
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET}
      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET}
      NODE_ENV: production
      TZ: Europe/Kyiv
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
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
      - "80:80"
      - "443:443"
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

### Стратегія оновлення
1. Watchtower (опц.) — автоматично пуллить нові образи
2. `Update.ps1` — контрольоване оновлення з міграцією БД
3. Rolling restart: зупинити api → мігрувати БД → запустити нові api + web

## Наслідки

- Розмір bundle: ~2-3 GB (всі образи + installer)
- RAM під час роботи: ~1.5-2 GB (весь стек)
- Час холодного старту: ~30-60 секунд
- Оновлення: ~5 хвилин без простою для клієнтів
