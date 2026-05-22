# STO ERP — API Конвенції

> Авторитетний стандарт для всіх HTTP ендпоінтів. Claude Code читає цей файл при генерації контролерів і DTO.

---

## 1. URL патерни

### Структура маршрутів

```
/api/{ресурс}                          GET (список), POST (створення)
/api/{ресурс}/:id                      GET (один), PATCH (оновлення), DELETE (soft)
/api/{ресурс}/:id/{вкладений-ресурс}   GET список вкладених
/api/{ресурс}/:id/{дія}                POST для FSM-переходів та команд
```

### Приклади

```
GET    /api/work-orders                     Список нарядів
POST   /api/work-orders                     Створити наряд
GET    /api/work-orders/:id                 Отримати наряд
PATCH  /api/work-orders/:id                 Оновити наряд
DELETE /api/work-orders/:id                 М'яке видалення

GET    /api/work-orders/:id/lines           Операції наряду
POST   /api/work-orders/:id/lines           Додати операцію
PATCH  /api/work-orders/:id/lines/:lineId   Оновити операцію

POST   /api/work-orders/:id/transition      FSM перехід (body: { to: "IN_PROGRESS" })
POST   /api/work-orders/:id/payments        Зафіксувати оплату

GET    /api/counterparties/:id/settlement   Баланс контрагента
GET    /api/stock-items?warehouseId=&goodId= Залишки (з фільтрами)
```

### Правила іменування

- Ресурси: `kebab-case`, множина: `work-orders`, `stock-items`, `purchase-orders`
- Параметри шляху: `camelCase` у NestJS декораторах, `kebab-case` в URL
- Query параметри: `camelCase`: `?pageSize=20&sortBy=createdAt&sortOrder=desc`
- FSM команди: іменник або дієслово через `/action`: `transition`, `archive`, `duplicate`

---

## 2. Формат відповідей

### Успішна відповідь — один об'єкт

```json
{
  "id": "uuid",
  "number": "WO-2024-0001",
  "status": "IN_PROGRESS",
  "totalAmount": "1250.00",
  "createdAt": "2024-05-21T10:30:00.000Z",
  "updatedAt": "2024-05-21T14:15:00.000Z"
}
```

### Успішна відповідь — список (пагінація)

```json
{
  "items": [...],
  "total": 142,
  "page": 1,
  "limit": 20,
  "totalPages": 8
}
```

### FSM перехід — відповідь

```json
{
  "id": "uuid",
  "status": "IN_PROGRESS",
  "previousStatus": "APPROVED",
  "transitionedAt": "2024-05-21T14:15:00.000Z"
}
```

---

## 3. Формат помилок

### Стандартна помилка

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Перехід DRAFT → PAID не дозволено",
  "code": "INVALID_TRANSITION"
}
```

### Помилка валідації (множинні поля)

```json
{
  "statusCode": 422,
  "error": "Unprocessable Entity",
  "message": "Помилки валідації",
  "code": "VALIDATION_ERROR",
  "details": [
    { "field": "vehicleId", "message": "Невалідний UUID" },
    { "field": "totalAmount", "message": "Сума повинна бути більше 0" }
  ]
}
```

### HTTP коди та коли використовувати

| Код | Коли |
|-----|------|
| `200` | GET, PATCH — успіх |
| `201` | POST — ресурс створено |
| `204` | DELETE — видалено, тіло пусте |
| `400` | Невалідний запит, порушення бізнес-правила |
| `401` | Не авторизовано (відсутній або невалідний токен) |
| `403` | Немає прав (роль не дозволяє) |
| `404` | Ресурс не знайдено або `deletedAt IS NOT NULL` |
| `409` | Конфлікт (дублікат, порушення унікальності) |
| `422` | Помилки валідації DTO |
| `500` | Внутрішня помилка сервера |

### Коди помилок (code field)

```typescript
// Всі коди в packages/shared/src/constants/error-codes.ts
export const ErrorCodes = {
  // FSM
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  GUARD_FAILED: 'GUARD_FAILED',
  // Auth
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  // Resources
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  // Business rules
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  BALANCE_MISMATCH: 'BALANCE_MISMATCH',
  FISCAL_QUEUE_FULL: 'FISCAL_QUEUE_FULL',
} as const;
```

**Усі повідомлення помилок — українською мовою.**

---

## 4. Пагінація та фільтрація

### Query параметри (стандартні)

```typescript
// Загальний PaginationQueryDto (packages/shared/src/dto/pagination.dto.ts)
export class PaginationQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number = 20;

  @IsOptional() @IsString()
  sortBy?: string = 'createdAt';

  @IsOptional() @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';

  @IsOptional() @IsString()
  search?: string;  // повнотекстовий пошук, якщо підтримується
}
```

### Фільтри для кожного ресурсу додаються через extend:

```typescript
export class WorkOrderQueryDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(WorkOrderStatus)
  status?: WorkOrderStatus;

  @IsOptional() @IsUUID()
  counterpartyId?: string;

  @IsOptional() @IsDateString()
  dateFrom?: string;  // ISO 8601

  @IsOptional() @IsDateString()
  dateTo?: string;
}
```

### Приклад запиту

```
GET /api/work-orders?page=2&limit=20&status=IN_PROGRESS&sortBy=plannedAt&sortOrder=asc
```

---

## 5. Дати та час

### Правила

- **У запитах (body/query):** ISO 8601 UTC: `"2024-05-21T10:30:00.000Z"`
- **У відповідях:** ISO 8601 UTC: `"2024-05-21T10:30:00.000Z"`
- **Конвертація у Kyiv timezone — тільки на клієнті** (web/mobile)
- **Ніколи не зберігати локальний час у БД**

```typescript
// Правильно: зберігаємо UTC, клієнт відображає у Kyiv
import { formatInTimeZone } from 'date-fns-tz';
const kyivTime = formatInTimeZone(utcDate, 'Europe/Kyiv', 'dd.MM.yyyy HH:mm');

// Неправильно: конвертація на бекенді перед збереженням
// ❌ const localDate = new Date(date.getTime() + 3 * 60 * 60 * 1000);
```

---

## 6. Числа та валюта

- **Decimal поля** (ціни, суми): повертаються як **рядки** `"1250.50"` (Prisma Decimal → string)
- **На клієнті** форматуємо через `formatCurrency()`:

```typescript
// packages/shared/src/utils/format.ts
export function formatCurrency(value: string | number): string {
  return new Intl.NumberFormat('uk-UA', {
    style: 'currency',
    currency: 'UAH',
    minimumFractionDigits: 2,
  }).format(Number(value));
  // Результат: "1 250,00 ₴"
}
```

---

## 7. Автентифікація

### JWT — схема

```
POST /api/auth/login      { phone, password } → { accessToken, refreshToken, user }
POST /api/auth/refresh    { refreshToken } → { accessToken, refreshToken }
POST /api/auth/logout     (Bearer) → 204
GET  /api/auth/me         (Bearer) → User
```

### Заголовки

```http
Authorization: Bearer <accessToken>
```

### Токени

| Токен | TTL | Де зберігати |
|-------|-----|--------------|
| `accessToken` | 15 хв | Пам'ять (не localStorage) |
| `refreshToken` | 30 днів | HttpOnly Cookie або SecureStorage (mobile) |

---

## 8. Tenant Isolation

Кожен запит автоматично фільтрується по `orgId` через guard:

```typescript
// apps/api/src/auth/guards/org-context.guard.ts
// Після JWT перевірки — встановлює req.orgId з токена
// Всі сервіси отримують orgId через @OrgId() декоратор

@Get()
async findAll(@OrgId() orgId: string, @Query() query: WorkOrderQueryDto) {
  return this.workOrdersService.findAll(orgId, query);
}
```

**Заборонено** приймати `orgId` з тіла запиту або query параметрів — тільки з JWT токена.

---

## 9. Swagger / OpenAPI

Всі ендпоінти повинні мати:

```typescript
@ApiTags('Work Orders')           // група в Swagger UI
@ApiOperation({ summary: '...' }) // короткий опис
@ApiResponse({ status: 201, type: WorkOrderResponseDto })
@ApiResponse({ status: 400, description: 'Помилки валідації' })
@ApiBearerAuth()                  // якщо потребує авторизації
```

Swagger UI доступний за адресою: `http://localhost:3000/api/docs`

---

## 10. Версіонування API

- Поточна версія: `v1` (вбудована в префікс `/api`)
- При breaking changes — `/api/v2/...`
- Стара версія підтримується мінімум 3 місяці після виходу нової
- Deprecation попередження через заголовок: `X-Deprecated: true`, `X-Sunset-Date: 2025-01-01`

