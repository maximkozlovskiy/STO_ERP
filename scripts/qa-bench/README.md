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
