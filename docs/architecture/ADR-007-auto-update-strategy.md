# ADR-007: Стратегія автоматичного оновлення

**Дата:** 2026-05-22
**Статус:** Прийнято · **Реалізовано 2026-09-09** (Update.ps1 rollback + exit-code, Register-ScheduledTasks.ps1)

> **Реалізація (F1/F2, хардненинг-бэклог):** `installer/scripts/Update.ps1` — фіксує поточну VERSION
> перед pull, застосовує міграції через one-off `run --rm` (старі контейнери працюють), health-check
> на `/api/health/live`; при таймауті/збої — автоматичний rollback (re-pull попередньої версії) +
> `exit 1` (усі fail-гілки exit 1, не exit 0). Rollback образів безпечний бо міграції additive-only
> (enforced `.github/workflows/ci.yml` migration-safety guard). `Register-ScheduledTasks.ps1` —
> нічний бекап УВІМКНЕНО (02:30), авто-update ЗАРЕЄСТРОВАНО+ВИМКНЕНО (opt-in, бо unattended-update на
> єдиному ПК ризикований).

## Контекст

STO ERP встановлюється на локальному сервері клієнта. Потрібен механізм доставки оновлень без приїзду технічного спеціаліста і без ризику втрати даних. Оновлення повинно: 1) відбуватись з мінімальним простоєм; 2) включати міграції БД; 3) мати можливість rollback.

## Розглянуті варіанти

### Варіант A: Ручне оновлення (новий .exe)

**Мінуси:** Клієнти не оновлюються, застарілі версії, support nightmare

### Варіант B: Watchtower (автоматичний pull нових образів)

**Плюси:** Простий, zero-config
**Мінуси:** Не контролює порядок (спочатку мігрувати БД, потім оновити API), ризик при неодночасному оновленні, не вирішує оновлення WSL2 port proxy після рестарту

### Варіант C: Update.ps1 + Windows Task Scheduler ✅

**Плюси:** Повний контроль над порядком, включає міграцію, можна викликати вручну або за розкладом

## Рішення: Контрольоване оновлення через Update.ps1

### Процес оновлення

```
1. Task Scheduler (щоночі о 03:00) або вручну запускає Update.ps1
2. Перевірка наявності нової версії в Registry (HTTPS якщо є інтернет)
3. Якщо нова версія:
   а. Backup.ps1 → резервна копія БД
   б. docker compose pull api web  (завантаження нових образів)
   в. docker compose stop api web
   г. docker compose run --rm api pnpm prisma migrate deploy
   д. docker compose up -d api web
   е. Health check (60 сек)
   ж. Якщо health check failed → Rollback до попередніх образів
4. Лог результату в C:\ProgramData\STO-ERP\logs\update.log
```

### Rollback механізм

```powershell
# Зберігаємо попередні теги образів перед оновленням
$previousApi = docker inspect sto-api --format '{{.Image}}'
$previousWeb = docker inspect sto-web --format '{{.Image}}'

# При невдачі:
docker tag $previousApi sto-api:rollback
docker compose up -d api web  # поверне попередню версію
```

### Мобільний додаток (Expo OTA Updates)

```typescript
// apps/mobile — Expo OTA для JS bundle (без App Store)
import * as Updates from 'expo-updates';

// При старті додатку:
const { isAvailable } = await Updates.checkForUpdateAsync();
if (isAvailable) {
  await Updates.fetchUpdateAsync();
  await Updates.reloadAsync(); // перезапуск з новим JS
}
// Native зміни (нові permissions) → нова версія через Google Play або APK
```

## Наслідки

- Windows Task Scheduler налаштовується під час встановлення
- Оновлення займає ~5 хвилин (downtime api+web ~ 2 хвилини)
- Рекомендований час: 03:00 (нічна перерва)
- Адмін отримує SMS/email після кожного оновлення
