# ADR-004: WatermelonDB для offline-first Mobile (Планшет механіка)

**Дата:** 2026-05-22
**Статус:** Прийнято

## Контекст

Механіки працюють на планшетах Android у боксах СТО. WiFi у боксах часто нестабільний або відсутній (метал, бетон). Механік повинен бачити свою чергу і оновлювати статус роботи навіть без з'єднання з API-сервером.

## Вимоги

- Перегляд черги робіт при відсутності WiFi
- Оновлення статусу робіт (старт/стоп таймер, виконано) при offline
- Синхронізація при відновленні з'єднання
- Фото зберігаються локально до відновлення з'єднання

## Розглянуті варіанти

### Варіант A: AsyncStorage (React Native KV)
**Мінуси:** Немає реляційних запитів, немає schema, не масштабується для складних даних

### Варіант B: React Query + refetchOnReconnect
**Мінуси:** Дані тільки в пам'яті — втрачаються при закритті додатку

### Варіант C: WatermelonDB ✅
**Плюси:**
- SQLite під капотом (надійний, швидкий)
- Реляційна модель + реактивні запити (RxJS)
- Вбудований sync-протокол (push/pull з API)
- Запис при offline → sync при відновленні
- Відмінна продуктивність навіть на слабких планшетах

## Рішення: WatermelonDB

### Які дані кешуються локально

```typescript
// Тільки що потрібно механіку, не вся БД
tables: [
  workOrders,       // мої наряди на сьогодні
  workOrderLines,   // рядки робіт (виконавець = я)
  workOrderParts,   // запчастини по нарядах
  vehicles,         // авто поточних нарядів
]
```

### Sync стратегія

```typescript
// apps/mobile/src/shared/lib/sync.ts
import { synchronize } from '@nozbe/watermelondb/sync';
import { database } from './watermelon';
import { apiClient } from '../api/client';

export async function syncWithServer() {
  await synchronize({
    database,
    pullChanges: async ({ lastPulledAt }) => {
      const { data } = await apiClient.get('/sync/pull', {
        params: { lastPulledAt, employeeId: getCurrentEmployeeId() }
      });
      return data; // { changes: {...}, timestamp: number }
    },
    pushChanges: async ({ changes }) => {
      await apiClient.post('/sync/push', { changes });
    },
    migrationsEnabledAtVersion: 1,
  });
}

// Автосинк при відновленні мережі
NetInfo.addEventListener(state => {
  if (state.isConnected) syncWithServer().catch(console.error);
});
```

### Фото при offline
```typescript
// Зберігаємо URI локально, завантажуємо при з'єднанні
await uploadQueue.add('upload-photo', {
  localUri: photo.uri,
  workOrderId,
}, { attempts: 20, backoff: { type: 'fixed', delay: 30_000 } });
```

## Наслідки

- API потребує `/sync/pull` і `/sync/push` ендпоінтів
- Конфлікти: last-write-wins по `updated_at` для більшості полів
- Обсяг локальних даних: ~50-200 MB залежно від кількості нарядів
