# qa-bench — контрольний diff для виміру QA-агентів

`seeded.patch` накладає на чисте дерево чотири відомі дефекти. Патч НЕ застосований у
репозиторії; він існує, щоб порівнювати роботу `sto-review-agent` і `sto-tester-agent`
на ОДНАКОВОМУ вході до і після зміни скілів (час, кількість кроків, знайдені дефекти).

| #   | Файл                                                | Дефект                                                     |
| --- | --------------------------------------------------- | ---------------------------------------------------------- |
| 1   | `apps/web/src/components/ui/date-picker-input.tsx`  | прибрано capture-слухач Escape — календар закриває модалку |
| 2   | `apps/api/src/modules/vehicles/vehicles.service.ts` | `vehicle.update` з `where: { id }` без `orgId`             |
| 3   | там само                                            | `vehicleNode.delete()` замість soft delete (є `deletedAt`) |
| 4   | `apps/web/src/hooks/api/useVehicleMileage.ts`       | новий хук із сирим `fetch(` замість `apiFetch`             |

```bash
git apply scripts/qa-bench/seeded.patch      # накласти
git apply -R scripts/qa-bench/seeded.patch   # зняти (якщо агент нічого не правив)
```

Агентові цей файл не показувати: вимір має сенс лише коли дефекти шукають наосліп.
Результати — `docs/PERFORMANCE-BASELINE.md`.

## `seeded-multi.patch` — шість дефектів у трьох агрегатах і на стику

Для виміру шардування (один шукач на весь diff проти шукача на кожен агрегат).

| #   | Файл                                                              | Дефект                                                     |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | `apps/api/src/modules/invoices/invoices.service.ts`               | з `findOne` прибрано `deletedAt: null`                     |
| 2   | `apps/web/src/hooks/api/useInvoices.ts`                           | хук кличе `/invoices/:id/status`, якого немає в контролері |
| 3   | `apps/api/src/modules/payments/payments.service.ts`               | переплата порівнюється з повною сумою, а не із залишком    |
| 4   | `apps/api/src/modules/purchase-orders/purchase-orders.service.ts` | over-receipt guard не враховує вже прийняте                |
| 5   | там само                                                          | статус пишеться з `where: { id }` без `orgId`              |
| 6   | `apps/api/src/common/utils/kyiv-date.ts`                          | СТИК: дні рахуються від UTC-дня, а не київського           |

Обидва патчі лежать у репозиторії, і шукач може їх знайти grep-ом — у прогоні 2026-10-07 двоє
так і здогадались, що дефекти підсаджені. Для чистого виміру патч треба тримати поза деревом.
