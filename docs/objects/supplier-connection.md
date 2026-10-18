# SupplierConnection — Підключення до API постачальника і замовлення через API (dossier)

> Підключення організації до API постачальників автозапчастин (Tehnomir, BM Parts, UTR, AD Ukraine /
> AutoTechnics, AVD Trade) і передача їм замовлень. Рішення власника 2026-10-18 (етапи 2+3 «Товари під
> замовлення»). Пропозиції й автопідбір — [supplier-offer.md](supplier-offer.md); списки купівлі —
> [purchase-list.md](purchase-list.md); замовлення постачальнику — [purchase-order.md](purchase-order.md).
> Ключів постачальників на момент реалізації немає: адаптери — за офіційними специфікаціями, перевірка —
> проти фейкових серверів `tools/supplier-fakes`; що звірити наживо — [docs/INTEGRATIONS.md](../INTEGRATIONS.md).

---

## Prisma модель

`packages/database/prisma/schema/11_supplier-api.prisma` — `SupplierConnection`, `SupplierOrder`,
`SupplierOrderLine` (+ пропозиції й дзеркало каталогу, див. supplier-offer.md); енуми в `01_enums.prisma`;
`PurchaseOrder.supplierApiStatus / supplierApiSentAt / supplierApiError`; налаштування
`OrganisationSettings.supplier*`. Міграції `20261018120000_supplier_api`,
`…120001_org_settings_supplier_api`, `…120002_purchase_items_offer_snapshot`.

---

## Бізнес-правила (BR-SCON)

- **BR-SCON-001**: **Підключення — на рівні організації, кілька одночасно.** Одне підключення на (постачальник-контрагент, провайдер) серед невидалених (partial-unique `supplier_connections_org_cp_provider_active_uq`; дубль → 409 `err.supplierConnection.duplicate`). Контрагент — організації, не видалений, з роллю постачальника (`assertCounterpartyRole`, BR-CP-001), інакше 400 `notSupplier`. Видалення — soft delete. Ролі: OWNER, ADMIN.
- **BR-SCON-002**: **Креди — лише на запис.** `credentials` і `authState` шифруються at-rest (`ENCRYPTED_FIELDS`) і ніколи не повертаються: відповідь містить лише `hasCredentials`. Оновлення зливає нові поля з наявними; порожній рядок не стирає збережене (як `ProviderConfigService.upsertConfig`). Секрети не потрапляють у `job.data`, логи (`redactSecrets`) і `lastError`.
- **BR-SCON-003**: **Склад полів — від провайдера.** Поля кредів і несекретних опцій (мапа «наш склад → точка/отримувач/перевізник» для AVD, конфіг доставки для BM) описує реєстр адаптерів (`GET /supplier-providers`); невідомі чи невалідні опції → 400 `invalidOptions`. Тестовий режим: BM — заголовок `X-Test-Mode: 1`, AVD — dev-хост; `apiUrl` — перевизначення бази (лише публічні адреси, BR-SCON-005).
- **BR-SCON-004**: **Перевірка підключення — через чергу.** `POST /supplier-connections/:id/verify` ставить `verifyStatus = PENDING` і задачу `verify`; результат (`OK` / `FAILED` + `lastVerifiedAt`, `lastError`) пише обробник. Без кредів → 400 `enterCredentialsFirst`. Синхронних викликів API постачальника з HTTP-запиту користувача немає ніде.
- **BR-SCON-005**: **HTTP до постачальника.** Лише публічні адреси (`validatePublicUrl`), без переходів за redirect, з тайм-аутом; помилки — типізовані (авторизація, ліміт, мережа, протокол), текст із префіксом «<провайдер> <статус>:» і без секретів. Виняток для локальних фейків — `SUPPLIER_API_DEV_ALLOWED_ORIGINS`, дозволений лише поза production (у production API не стартує, якщо змінну задано).
- **BR-SCON-006**: **Черги й повтори.** Зовнішні черги `supplier-search`, `supplier-order`, `supplier-catalog`: кожна задача — `attempts: 10`, експоненційний backoff (ADR-005, гейт `payments.queue-retry-policy.spec.ts`); `supplier-maintenance` — внутрішня. Обробники — `DeadLetterWorkerHost`, `runWithTenant`, `IntegrationLogService.wrap`. Помилка, яку повтор не виправить (невірні креди, 400, невідповідний протокол), — `UnrecoverableError`, і доменний рядок одразу FAILED з причиною. Недоступний Redis не губить роботу: рядок лишається QUEUED, його переставляє `sweep`.
- **BR-SCON-007**: **Ліміти постачальника.** 429 або вичерпана квота (`x-ratelimit-*`, `Retry-After`) відкладає задачу до скидання квоти без витрати спроби (`moveToDelayed` + `DelayedError`); квота зберігається в Redis на підключення (AVD — спільна для всіх ключів клієнта).
- **BR-SCON-008**: **Авторизація.** Статичні ключі (Tehnomir — у тілі, AVD — `x-api-key`, BM — `Authorization` + обов'язковий `User-Agent`); UTR — логін → JWT з оновленням, AD — логін → JWT (повторний логін). JWT кешується в шифрованому `authState`; оновлення серіалізується м'ютексом у Redis на підключення; 401/403 → одна повторна авторизація, далі — FAILED.
- **BR-SCON-009**: **Режим передачі замовлення** (`OrganisationSettings.supplierOrderSendMode`, рішення власника): `MANUAL` — кнопкою «Відправити в API» в картці замовлення; `ON_ORDERED` — автоматично при переході замовлення в «Замовлено», якщо постачальник має увімкнене підключення. У режимі `ON_ORDERED` перехід у тій самій транзакції ставить `supplierApiStatus = QUEUED` (outbox), постановку в чергу робить подія після коміту, а `sweep` підхоплює пропущене. Кнопка з «Чернетки» спершу переводить замовлення в «Замовлено». Ролі: OWNER, ADMIN, STOREKEEPER.
- **BR-SCON-010**: **Планування відправки.** Рядок замовлення відправляється лише з пропозицією зі знімка позицій списку цього замовлення й товару (BR-SOFR-008); рядок без пропозиції → 400 `lineWithoutOffer` (з назвами товарів), різні пропозиції на той самий товар із розбіжною кількістю → `ambiguousOffer`, пропозиція іншого підключення → `offerFromOtherConnection`, вимкнене підключення → `connectionDisabled`, немає мапи нашого складу → `noWarehouseMapping`. План (`SupplierOrder` + рядки) — заморожений знімок відправленого; ручні рядки замовлення (не зі списку) в API не відправляються.
- **BR-SCON-011**: **Відправка відновлюється по кроках і не дублює замовлення.** Кожен крок провайдера (кошик, рядки, оформлення) записується в `SupplierOrder.step` до наступного; повтор задачі продовжує з записаного кроку. Рядки кошика AVD — `operation: 'replace'`. Тайм-аут чи 5xx після неповторюваного виклику (оформлення, створення замовлення) → крок `RECONCILE`: пошук замовлення за нашим `reference`; знайдено — продовжуємо, ні — `UNKNOWN`, замовлення `NEEDS_ATTENTION` («перевірте в кабінеті постачальника»). Повторного оформлення без перевірки немає.
- **BR-SCON-012**: **Статуси постачальника.** Сирий статус → нормалізований за таблицею провайдера; невідомий сирий статус не змінює нормалізований (лише `externalStatusRaw` і попередження в журналі). Опитування — повторювана задача з інтервалом `supplierOrderPollIntervalMinutes` для нетермінальних замовлень і кнопка «Оновити статус». Зовнішній статус **не** змінює залишків, боргу й FSM замовлення: приймання — лише вручну (`receive`, BR-PO-005).
- **BR-SCON-013**: **Підсумок на замовленні.** `supplierApiStatus`: усі зовнішні підтверджені → `CONFIRMED`; є недопідтверджені рядки → `PARTIAL`; є FAILED → `FAILED`; є UNKNOWN → `NEEDS_ATTENTION`. «Повернути непідтверджене в список» (кнопка, рішення за замовчуванням) ділить ORDERED-позиції на непідтверджену кількість і повертає її в OPEN без пропозиції (`splitOff`).
- **BR-SCON-014**: **Скасування відправленого.** Скасування чи видалення замовлення, яке вже має зовнішнє замовлення в стані PLACED / CONFIRMED / PARTIALLY_CONFIRMED / READY / SHIPPED / UNKNOWN, → 400 `cancelSentOrder`, доки запит не містить `force: true`; у web — підтвердження «замовлення вже в постачальника — скасуйте його в кабінеті постачальника» (рішення власника). API постачальника для скасування не викликається.
- **BR-SCON-015**: **Дзеркало каталогу AVD.** AVD не шукає за артикулом, тож пошук іде по локальному дзеркалу `SupplierCatalogItem`: синхронізація — повторювана задача з інтервалом `supplierCatalogSyncIntervalMinutes` і кнопка «Синхронізувати каталог»; масовий upsert за (підключення, id товару постачальника), не побачене в синхронізації — `deletedAt`; дзеркало старше подвоєного інтервалу — пропозиції з позначкою «застаріле».

---

## API Endpoints

Модуль `apps/api/src/modules/supplier-api/` (контролери `connections/`, `orders/`).

| Метод         | URL                                                                                                 | Ролі                                  | Що робить                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| GET           | `/supplier-providers`                                                                               | OWNER, ADMIN                          | постачальники API: можливості, поля кредів, опцій і параметрів складу (BR-SCON-003) |
| GET           | `/supplier-connections`                                                                             | OWNER, ADMIN                          | підключення організації (без секретів)                                              |
| GET           | `/supplier-connections/:id`                                                                         | OWNER, ADMIN                          | одне підключення                                                                    |
| POST          | `/supplier-connections`                                                                             | OWNER, ADMIN                          | нове підключення (BR-SCON-001…003, 005)                                             |
| PATCH         | `/supplier-connections/:id`                                                                         | OWNER, ADMIN                          | зміна; креди зливаються, порожнє не стирає (BR-SCON-002)                            |
| DELETE        | `/supplier-connections/:id`                                                                         | OWNER, ADMIN                          | soft delete                                                                         |
| POST          | `/supplier-connections/:id/verify`                                                                  | OWNER, ADMIN                          | перевірка — задача `supplier-search`, 202 (BR-SCON-004)                             |
| POST          | `/supplier-connections/:id/catalog-sync`                                                            | OWNER, ADMIN                          | синхронізація дзеркала AVD — задача `supplier-catalog`, 202 (BR-SCON-015)           |
| GET           | `/purchase-orders/:id/supplier-api`                                                                 | OWNER, ADMIN, STOREKEEPER, ACCOUNTANT | стан передачі: підсумок, зовнішні замовлення, рядки, попередження (BR-PO-011)       |
| POST          | `/purchase-orders/:id/supplier-api/send`                                                            | OWNER, ADMIN, STOREKEEPER             | «Відправити в API», Idempotency-Key, 202 (BR-SCON-009, 010)                         |
| POST          | `/purchase-orders/:id/supplier-api/poll`                                                            | OWNER, ADMIN, STOREKEEPER             | «Оновити статус» — задача `poll-now`, 202 (BR-SCON-012)                             |
| POST          | `/purchase-orders/:id/supplier-api/release-unconfirmed`                                             | OWNER, ADMIN, STOREKEEPER             | повернути непідтверджене в список (BR-SCON-013)                                     |
| POST / DELETE | `/purchase-orders/:id/transition` `{status: 'CANCELLED', force}`, `/purchase-orders/:id?force=true` | як у замовлення                       | скасування / видалення відправленого — лише з `force` (BR-SCON-014)                 |

Черги: `supplier-search` (`verify`, `search`), `supplier-order` (`place`, `poll-now`, повторювана `poll-due`),
`supplier-catalog` (`sync`, повторювана `sync-due`) — зовнішні, кожен `add()` з `attempts: 10` і
експоненційним backoff; `supplier-maintenance` (`sweep`) — внутрішня (ADR-005).

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/supplier-api/<тека>/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/supplier-api/`

| Аспект                                                                                                                                                | Тест                                               | Кейсів |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------ |
| HTTP-контракт: ролі (BR-SCON-001, 009; BR-SOFR-002), zod-тіла, 202 для черги                                                                          | `supplier-api.contract.spec.ts`                    | 17     |
| HTTP до постачальника: адреси, redirect, тайм-аут, типізовані помилки, секрети, квота (BR-SCON-005, 007, 011)                                         | `http/supplier-http.client.spec.ts`                | 14     |
| allowlist локальних фейків лише поза production (BR-SCON-005)                                                                                         | `http/supplier-url-policy.spec.ts`                 | 4      |
| JWT постачальника: кеш, оновлення під м’ютексом, одна повторна авторизація (BR-SCON-008)                                                              | `auth/supplier-auth.session.spec.ts`               | 8      |
| реєстр адаптерів і опції з опису провайдера (BR-SCON-003)                                                                                             | `adapters/supplier-adapter-registry.spec.ts`       | 4      |
| AVD проти фейку: ключ, дзеркало (items/query, export 202), кошик replace, звірка за кошиком, статуси, спільна квота (BR-SCON-007, 008, 011, 012, 015) | `adapters/avd-trade/avd-trade.contract.spec.ts`    | 11     |
| UTR проти фейку: логін і refresh, пошук, order/accept, звірка за коментарем, невідомий статус (BR-SCON-008, 010…012)                                  | `adapters/utr/utr.contract.spec.ts`                | 7      |
| BM Parts проти фейку: заголовки, strict-пошук з аналогами, кошик → резерв → відвантаження, статуси (BR-SCON-008, 010…012)                             | `adapters/bm-parts/bm-parts.contract.spec.ts`      | 8      |
| Tehnomir проти фейку: токен у тілі, позиції кошика з reference, order/create лише своїх, стани позицій, 503 = ліміт (BR-SCON-007, 008, 011, 012)      | `adapters/tehnomir/tehnomir.contract.spec.ts`      | 8      |
| AD проти фейку: JWT з exp, повторний логін, order/create по складу, звірка, статус (BR-SCON-008, 010…012)                                             | `adapters/ad-ukraine/ad-ukraine.contract.spec.ts`  | 6      |
| підключення: роль постачальника, дубль, креди лише на запис, опції, перевірка через чергу (BR-SCON-001…006)                                           | `connections/supplier-connections.service.spec.ts` | 10     |
| обробник `verify`: OK / FAILED, UnrecoverableError, ліміт без витрати спроби (BR-SCON-004, 006, 007)                                                  | `processors/supplier-search.verify.spec.ts`        | 5      |
| `sweep`: перепостановка загублених рядків, очищення пропозицій (BR-SCON-006, BR-SOFR-003)                                                             | `processors/supplier-maintenance.sweep.spec.ts`    | 2      |
| дзеркало AVD: upsert сирим SQL, зняття не побачених, збій без видалення (BR-SCON-015)                                                                 | `catalog/supplier-catalog.sync.spec.ts`            | 5      |
| планування відправки й підсумок `supplierApiStatus` — чисті функції (BR-SCON-010, 013)                                                                | `orders/supplier-order-planner.spec.ts`            | 17     |
| відправка: кнопка, outbox, кроки, звірка, UNKNOWN, статуси, «Повернути непідтверджене», скасування (BR-SCON-009…014, BR-PO-011, 012)                  | `orders/supplier-orders.send.spec.ts`              | 19     |

Разом тут: **145** кейсів; разом із реєстром [supplier-offer.md](supplier-offer.md) — **212** у модулі
(цифри з `vitest --reporter=json`).

Поза модулем: `config/env.schema.spec.ts` — відмова старту з allowlist у production (BR-SCON-005);
`purchase-orders/purchase-orders.contract.spec.ts` — `force` у переході (BR-PO-012);
`payments/payments.queue-retry-policy.spec.ts` — політика повторів нових черг (BR-SCON-006).

Спільне: `supplier-api.spec-fixture.ts` (Redis у пам'яті, справжній HTTP-клієнт з allowlist фейку),
`orders/supplier-orders.spec-fixture.ts` (поверх `procurementHarness` списків купівлі),
`offers/supplier-offers.spec-fixture.ts`. Фейкові сервери постачальників — `tools/supplier-fakes`
(`node tools/supplier-fakes/bin.js --port 4100`; керування `/__scenario`, `/__requests`, `/__reset`).
