# Loyalty — Dossier

> Програма лояльності: клієнти накопичують бали за оплати (earn) і списують їх як
> знижку (redeem). Нарахування автоматичне (BullMQ-черга при кожному платежі),
> списання — ручне на картці контрагента.

---

## Prisma модель

```prisma
model LoyaltyAccount {
  id             String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId          String   @db.Uuid
  counterpartyId String   @unique @db.Uuid          // 1 рахунок на контрагента
  balance        Decimal  @default(0) @db.Decimal(12, 2)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  syncVersion    BigInt   @default(0)
  // немає deletedAt — рахунок лояльності не видаляється
}

// Append-only — ніколи не редагується
model LoyaltyTransaction {
  id           String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  accountId    String   @db.Uuid
  type         String   // EARN | REDEEM (рядковий, не enum)
  points       Decimal  @db.Decimal(12, 2)
  documentId   String?  @db.Uuid                    // для EARN — id Payment
  documentType String?                              // для EARN — 'Payment'
  notes        String?
  createdAt    DateTime @default(now())
  // немає deletedAt, updatedAt, orgId — леджер незмінний, orgId через account
}
```

**Відносини:**

- `LoyaltyAccount` → `Organisation` (M:1), → `Counterparty` (M:1, `counterpartyId` `@unique`)
- `LoyaltyAccount` ← `LoyaltyTransaction[]` (1:M через `accountId`)

**Індекси:**

- `LoyaltyAccount`: `(orgId)`, `(orgId, syncVersion)`
- `LoyaltyTransaction`: `(accountId, createdAt)`
- **Partial-unique** `loyalty_earn_one_per_document_uq` — `WHERE type='EARN' AND "documentId" IS NOT NULL`
  (Prisma не виражає partial-unique у `@@unique`, живе у міграції `20260909…_loyalty_earn_idempotency`).
  Гарантує один EARN на документ → захист від подвійного нарахування при паралельних/повторних BullMQ-джобах.

---

## Налаштування (`OrganisationSettings`)

Конфігурованість (не hardcode) — 4 поля, редагуються у `settings/LoyaltyTab.tsx`:

| Поле                | Тип             | Default | Значення                                                |
| ------------------- | --------------- | ------- | ------------------------------------------------------- |
| `loyaltyEnabled`    | `Boolean`       | `false` | Вимикач **нарахування** (списання працює завжди)        |
| `loyaltyEarnPer`    | `Decimal(10,2)` | `100`   | За кожні N грн оплати нараховується батч балів          |
| `loyaltyEarnPoints` | `Decimal(10,2)` | `1`     | Скільки балів за той батч (100 грн + 1 → 1 бал/100 грн) |
| `loyaltyRedeemRate` | `Decimal(10,2)` | `1`     | 1 бал = N грн знижки при списанні                       |

Міграція полів: `20260526210000_loyalty_program`.

---

## API Endpoints (`/api/loyalty`)

| Метод | URL                                         | Дія                                                                | Ролі                                   |
| ----- | ------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| GET   | `/api/loyalty/balance/:counterpartyId`      | Баланс балів (`{ balance, counterpartyId }`; 0 якщо рахунку немає) | OWNER, ADMIN, RECEPTIONIST, ACCOUNTANT |
| GET   | `/api/loyalty/transactions/:counterpartyId` | Останні 50 транзакцій + `total`                                    | OWNER, ADMIN, RECEPTIONIST, ACCOUNTANT |
| POST  | `/api/loyalty/redeem/:counterpartyId`       | Списати бали (`RedeemLoyaltyDto`) → `{ discountAmount }`           | OWNER, ADMIN, RECEPTIONIST             |

`RedeemLoyaltyDto`: `points: number` (`@Min(1) @Max(100_000)`).

> Немає окремого endpoint для earn — нарахування лише через чергу (див. Side-effects).

---

## UI (Web)

| Компонент / сторінка  | Файл                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Налаштування програми | `app/(app)/settings/LoyaltyTab.tsx` (патчить 4 org-поля через `/settings/organisation`)                                             |
| Баланс + списання     | `app/(app)/counterparties/[id]/PageClient.tsx` — таб «Лояльність» (`GET /loyalty/balance`, `/transactions`, `POST /loyalty/redeem`) |

---

## Бізнес-правила (BR-LOY)

### Нарахування (earn) — асинхронне через BullMQ

- **BR-LOY-001**: `PaymentsService.create()` після успішного платежу викликає `LoyaltyService.queueEarn(orgId,
counterpartyId, amount, payment.id)` → черга `loyalty`, job `earn` (`attempts: 10`, exponential
  backoff 30 с). Non-blocking: якщо черга недоступна — warn, платіж лишається.
- **BR-LOY-002**: `LoyaltyProcessor` (concurrency 3) виконує `LoyaltyService.earn()`. Порядок:
  1. Guard `Number.isFinite(paymentAmount) && amount > 0` (інакше `increment: NaN` зберіг би `null`).
  2. Читає `loyaltyEnabled` — якщо `false`, early return (бали не нараховуються).
  3. `points = roundMoney(Math.floor(amount / earnPer) * earnPoints)` — квантування до 2dp,
     щоб `balance` і `LoyaltyTransaction.points` збігались з тим, що зберігає БД. `points<=0` → skip.
  4. У `$transaction`: idempotency-guard (див. нижче) → `balance += points` → `LoyaltyTransaction(EARN)`.

### Idempotency нарахування (міграція `loyalty_earn_idempotency`)

- **BR-LOY-003**: **Один EARN на документ (Payment).** BullMQ може повторити job (worker помер після commit до ACK,
  або payment enqueued двічі) → без захисту було б подвійне нарахування.
- **BR-LOY-004**: **Два рівні захисту:**
  - **BR-LOY-005**: _Послідовні повтори_ — read-then-write: `findFirst({ accountId, type:'EARN', documentId })` → якщо є, skip.
  - **BR-LOY-006**: _Паралельні джоби_ — partial-unique `loyalty_earn_one_per_document_uq` → другий insert кидає
    `P2002`, який `earn()` ковтає (транзакція відкочується цілком, `balance`-increment теж не застосовано).
- **BR-LOY-007**: Нарахування без документа (`documentId == null`, ручний шлях) — без anchor, завжди трактується як нове.

### Списання (redeem) — синхронне, атомарне

- **BR-LOY-008**: `redeem()`: `points = roundMoney(pointsInput)` (2dp — decrement і рядок леджера мусять збігатись).
- **BR-LOY-009**: **Atomic check-and-decrement** проти double-spend: `updateMany({ where: { id, balance: { gte: points } },
data: { balance: { decrement: points } } })` — `UPDATE … WHERE balance >= N` оцінюється атомарно
  Postgres. `count === 0` → `BadRequestException('Недостатньо балів')`.
- **BR-LOY-010**: `discountAmount = roundMoney(points * loyaltyRedeemRate)` — сума знижки у грн (повертається клієнту).
- **BR-LOY-011**: Записує `LoyaltyTransaction(REDEEM)` у тій самій `$transaction`.

### Tenant isolation

- **BR-LOY-012**: Кожен виклик перевіряє `counterparty { id, orgId, deletedAt: null }` → `NotFound` якщо чужий/видалений.
- **BR-LOY-013**: `LoyaltyAccount` фільтрується по `orgId` у всіх reads.

---

## Side-effects

| Джерело                             | Ефект                                                                |
| ----------------------------------- | -------------------------------------------------------------------- |
| `Payment.create` (будь-який платіж) | `queueEarn` → job `earn` → нарахування балів (якщо `loyaltyEnabled`) |
| `POST /loyalty/redeem`              | Списання балів + повернення `discountAmount` для знижки              |

## Пов'язані об'єкти

- [payments.md](payments.md) — джерело earn-подій · [counterparty.md](counterparty.md) — власник рахунку

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/loyalty/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/loyalty/`

| Аспект           | Тест                        | Кейсів |
| ---------------- | --------------------------- | ------ |
| BullMQ-processor | `loyalty.processor.spec.ts` | 5      |
| сервісна логіка  | `loyalty.service.spec.ts`   | 23     |
| tenant isolation | `loyalty.tenant.spec.ts`    | 13     |

Разом: **41** кейсів (цифри з `vitest --reporter=json`, не з grep).

**Чого тут НЕМА.** Інваріантного спеку (`*.invariants.spec.ts`) немає, хоча агрегат на шляху грошей або статусів: властивості на кшталт «фінальний статус без виходів» не стережуться нічим. Свідома прогалина — кандидат на окремий крок.

HTTP-контракту (`*.contract.spec.ts`) немає: DTO, статуси й валідацію покриває лише E2E.

Три правила мають мітку `// guards:`, але unit-тест стереже їх лише частково (ідентифікатори тут
навмисно не повторено — гейт D вважає правило, назване в цьому блоці, прогалиною):

- постановка в чергу при платежі — у цьому модулі стережеться лише `queueEarn` (черга, job, `attempts`,
  backoff). Виклик з `PaymentsService.create()` і non-blocking `catch` живуть у спеках модуля `payments`.
- паралельні earn-джоби — стережеться лише те, що `earn()` ковтає `P2002`. Сам partial-unique індекс
  `loyalty_earn_one_per_document_uq` і відкат `balance`-increment разом із транзакцією перевіряються
  тільки на справжній БД; інтеграційного тесту на паралельні джоби немає.
- atomic check-and-decrement — атомарність `UPDATE … WHERE balance >= N` дає Postgres; unit-тест стереже
  форму запиту (`gte` + `decrement` в одному `updateMany`) і реакцію на `count === 0`, а не саму гонку
  двох redeem.

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
