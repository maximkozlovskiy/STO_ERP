# [EntityName] — Dossier

> Вертикальний зріз по агрегату: FSM, Prisma модель, endpoints, DTO, UI.
> Оновлювати при зміні схеми, FSM або ключових endpoints.

---

## Prisma модель

```prisma
model EntityName {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String    @db.Uuid
  // ... поля
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?
  syncVersion BigInt    @default(0)
}
```

**Відносини:**

- → `RelatedModel` (M:1 через `relatedId`)
- ← `ChildModel[]` (1:M)

---

## FSM (якщо є)

```
STATE_A → STATE_B → STATE_C
        ↘ CANCELLED
```

| Перехід       | Side-effects |
| ------------- | ------------ |
| → `STATE_B`   | ...          |
| → `CANCELLED` | ...          |

---

## API Endpoints

| Метод  | URL                        | DTO               | Ролі         |
| ------ | -------------------------- | ----------------- | ------------ |
| POST   | `/api/entities`            | `CreateEntityDto` | ADMIN, OWNER |
| GET    | `/api/entities`            | `EntityQueryDto`  | всі          |
| GET    | `/api/entities/:id`        | —                 | всі          |
| PATCH  | `/api/entities/:id`        | `UpdateEntityDto` | ADMIN, OWNER |
| PATCH  | `/api/entities/:id/action` | `ActionDto`       | ADMIN        |
| DELETE | `/api/entities/:id`        | —                 | ADMIN, OWNER |

---

## DTO (ключові поля)

```typescript
class CreateEntityDto {
  @IsUUID() field1: string;
  @IsString() @IsOptional() field2?: string;
}

class EntityResponseDto {
  id: string;
  status: EntityStatus;
  // ...
}
```

---

## UI (Web)

| Компонент / сторінка | Файл                                     |
| -------------------- | ---------------------------------------- |
| Список               | `app/(app)/entities/page.tsx`            |
| Деталь               | `app/(app)/entities/[id]/PageClient.tsx` |
| Модалка створення    | `components/ui/CreateEntityModal.tsx`    |
| Detail Panel schema  | `lib/panel-schema.ts` → `ENTITY_SCHEMA`  |

---

## Бізнес-правила

- Правило 1
- Правило 2

→ Детально у [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
