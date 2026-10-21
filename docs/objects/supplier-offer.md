# SupplierOffer — Пропозиції постачальників і автопідбір (dossier)

> Пропозиції (ціна, наявність, склад, термін) від підключених постачальників для позицій списку
> купівлі; ручний вибір і автопідбір за стратегією «швидко / дешево / оптимально». Рішення власника
> 2026-10-18. Підключення, черги й замовлення через API — [supplier-connection.md](supplier-connection.md).

---

## Prisma модель

`packages/database/prisma/schema/11_supplier-api.prisma` — `SupplierOfferBatch`, `SupplierOfferRequest`,
`SupplierOffer`, `SupplierCatalogItem`; знімок обраної пропозиції — поля `offer*` у `PurchaseListItem`
(`07_inventory.prisma`); налаштування — `OrganisationSettings.supplier*`.

---

## Бізнес-правила (BR-SOFR)

- **BR-SOFR-001**: **Нормалізована пропозиція.** Кожен адаптер повертає `{supplierItemId, article, brand, name, price, currencyCode, qty, qtyIsLowerBound, warehouseCode, warehouseName, deliveryDays?, deliveryDate?, multiplicity?, isAnalog, offerKey}`; `offerKey` — те, що потрібно постачальнику для замовлення (товар + склад / прайс). Кількість «>10» / «5+» → `qty` = межа, `qtyIsLowerBound = true`. Пропозиція з `qty ≤ 0` чи `price ≤ 0` не зберігається.
- **BR-SOFR-002**: **Пошук — через чергу, результати — у БД.** `POST /supplier-offers/search` створює batch і запит на кожну пару (позиція × увімкнене підключення); артикул і бренд — із товару позиції (`normalizeArticle`, `BrandSynonym`). Свіжий (у межах `supplierOfferTtlMinutes`) виконаний запит того самого підключення й артикулу використовується повторно (`fromCache`) без задачі. UI опитує легкий `GET /supplier-offers/batches/:id/status`, а повний `GET /supplier-offers/batches/:id` перечитує, коли запит завершився; стан кожного підключення: черга / виконується / «немає зв'язку — повтор о HH:MM» / готово (з кешу від …, застаріле) / помилка. Ролі: OWNER, ADMIN, STOREKEEPER.
- **BR-SOFR-003**: **Офлайн — останні відомі пропозиції.** `GET /purchase-list-items/:id/offers` віддає останні збережені пропозиції без звернення до мережі; пропозиція старша за TTL позначена «застаріла», але не видаляється. Видаляє лише внутрішнє очищення старших за `supplierOfferRetentionDays`.
- **BR-SOFR-004**: **Звірка з каталогом.** Кожна пропозиція звіряється з товарами організації (`GoodMatcherService.matchMany`: код → артикул + бренд → штрихкод → артикул): `matched` / `ambiguous` / `notFound`; `isAnalog` — пропозиція не на товар позиції: збіг з іншим товаром, інший артикул, позначка постачальника, неоднозначний збіг або той самий артикул **іншого бренду** (бренди пропозиції й товару позиції задані й не збігаються; review 2026-10-18).
- **BR-SOFR-005**: **Аналоги** (`OrganisationSettings.supplierAnalogPolicy`, рішення власника). Для позиції з наряду аналог видно, але не обирається (спершу змінюють товар у наряді). Для ручної позиції: `CREATE_AND_REPLACE` — знайдений або новий товар (ціна продажу — як у товару позиції) замінює товар позиції, `originalGoodId` пам'ятає попередній; новий товар створюється під advisory-блокуванням за (організація, нормалізований артикул) — повторний чи одночасний вибір того самого аналога бере вже створений товар (той самий артикул і бренд), а 409 позиції знімає щойно створений товар; вибір пропозиції на товар, для якого шукали (не аналог), після заміни повертає товар-оригінал і очищає `originalGoodId`; `CATALOG_ONLY` — обирається лише аналог, знайдений у каталозі (`matched`); `SHOW_ONLY` — не обирається. Не можна обрати → 400 `analogNotSelectable`.
- **BR-SOFR-006**: **Ручний вибір** (`POST /purchase-list-items/:id/choose-offer`). Лише OPEN-позиція (BR-PL-005, CAS); пропозиція — цієї організації й одного з запитів позиції (інакше 404 `offerNotFound`). Вибір ставить `supplierId` = контрагент підключення, `expectedPrice` = ціна пропозиції **в гривні** за курсом на момент вибору (`ExchangeRatesService.getRateAsOf`; немає курсу → 400), знімок `offer*` (ціна й валюта — як у постачальника), `offeredAt`, `offerChosenBy = MANUAL`. Кратність пропозиції > 1 — кількість позиції округлюється до неї вгору, як в автопідборі (надлишок допускається; Bug #890). Зняття вибору (`DELETE …/offer`) очищає знімок, постачальника й ціну не чіпає.
- **BR-SOFR-007**: **Стратегії** (`strategy/offer-allocation.ts`, чиста функція). Ціни порівнюються в гривні; пропозиція без курсу виключається. Термін = `deliveryDays` ?? дні до `deliveryDate` ?? `defaultDeliveryDays` підключення ?? `supplierUnknownDeliveryDays`. Замовна кількість — до кратності вгору; обмежена кількість (`qtyIsLowerBound`) вважається рівною межі. Оцінка (менше — краще): «дешево» — сума замовлення, нічия — за терміном; «швидко» — термін, нічия — за сумою; «оптимально» — `w · norm(ціна) + (1 − w) · norm(термін)` з `w = supplierOptimalPriceWeight`, нормування min–max серед допустимих пропозицій позиції. Остаточна нічия — `priority` підключення, далі `offerKey`: результат детермінований за будь-якого порядку пропозицій.
- **BR-SOFR-008**: **Покриття кількості.** Перша — найкраща пропозиція, що покриває всю потребу. Якщо такої немає — жадібно за оцінкою: між складами одного постачальника — завжди, між різними постачальниками — лише коли `supplierAllowSplit` (рішення власника); інакше — найкраща часткова. Непокрита решта лишається окремою OPEN-позицією без пропозиції. Аналоги в автопідборі — лише коли `supplierAllowAnalogsInAuto` і політика BR-SOFR-005 дозволяє вибір.
- **BR-SOFR-009**: **Застосування автопідбору** (`POST /supplier-offers/allocate {batchId, strategy, dryRun}`). `dryRun` повертає розподіл без запису. Застосування — одна транзакція: кожна позиція — CAS BR-PL-005; одна частка — знімок на позицію; кілька — позиція ділиться (знімок на кожну частину, BR-PL-017); `offerChosenBy = AUTO`; `expectedPrice` — у гривні. Перегляд повертає `previewToken` — відбиток розподілу (позиції, частини, кількості, ціни в гривні); застосування з ним, якщо розподіл відтоді змінився (позиції, пропозиції чи курс), → 409 `allocationChanged`, нічого не записано; позиція, змінена між розрахунком і записом, → 409 `concurrentChange`. Одна пропозиція (спільний кешований запит) ділиться між позиціями batch-у в їхньому порядку — сумарно не більше за наявне. Позицію з ручним вибором (`offerChosenBy = MANUAL`) автопідбір не чіпає (`skippedReason: manualChoice`), доки запит не містить `overrideManual: true` (рішення за замовчуванням 2026-10-18; у web — прапорець «Перезаписати ручний вибір», типово вимкнений).
- **BR-SOFR-010**: **Видимість цін.** Ціни пропозицій і знімка (`offerPrice`) бачать OWNER, ADMIN, STOREKEEPER; RECEPTIONIST і MECHANIC отримують `null` — як очікувану закупівельну ціну (`maskItemCost`).

---

## API Endpoints

| Метод  | URL                                     | Ролі                      | Що робить                                                                                        |
| ------ | --------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| POST   | `/supplier-offers/search`               | OWNER, ADMIN, STOREKEEPER | batch і запити (позиція × увімкнене підключення), кеш у межах TTL, 202 (BR-SOFR-002)             |
| GET    | `/supplier-offers/batches/:id`          | OWNER, ADMIN, STOREKEEPER | стан batch: підключення, «повтор о», пропозиції з `selectable` і причиною                        |
| GET    | `/supplier-offers/batches/:id/status`   | OWNER, ADMIN, STOREKEEPER | легкий стан для опитування: лише статуси запитів (`status`, `nextRetryAt`, `fromCache`, `error`) |
| POST   | `/supplier-offers/allocate`             | OWNER, ADMIN, STOREKEEPER | автопідбір `{batchId, strategy, dryRun, overrideManual}` (BR-SOFR-007…009)                       |
| GET    | `/supplier-offers/settings`             | OWNER, ADMIN, STOREKEEPER | стратегія за замовчуванням, TTL, ділення, аналоги — для діалогів (без інших налаштувань)         |
| GET    | `/purchase-list-items/:id/offers`       | OWNER, ADMIN, STOREKEEPER | останні відомі пропозиції позиції без мережі (BR-SOFR-003)                                       |
| POST   | `/purchase-list-items/:id/choose-offer` | OWNER, ADMIN, STOREKEEPER | ручний вибір (BR-SOFR-005, 006)                                                                  |
| DELETE | `/purchase-list-items/:id/offer`        | OWNER, ADMIN, STOREKEEPER | зняти вибір                                                                                      |

Налаштування — `PATCH /settings/organisation` (`supplier*`), межі в DTO й CHECK міграції.

---

## UI (Web)

**Маршрут UI:** `/purchase-orders?tab=procurement&view=items`

- `purchase-orders/procurement/ItemsView.tsx` — у рядку OPEN-позиції «Пропозиції», під постачальником
  — бейдж обраної пропозиції (`purchase-list/OfferBadge.tsx`: склад, термін, давність, «застаріла»
  за TTL — без цін, BR-SOFR-010); масова дія «Підібрати автоматично»; дії — лише OWNER, ADMIN,
  STOREKEEPER (приймальня не бачить і не питає `GET /supplier-offers/settings`);
- `components/ui/purchase-list/SupplierOffersDialog.tsx` — відкриття запускає пошук (кеш у межах
  TTL), «Оновити» — `refresh`; чипи стану кожного підключення («Завантаження…», «Немає зв'язку —
  повтор о HH:MM», «З кешу від …», «Помилка»); поки підключення не відповіло — останні відомі
  пропозиції; таблиця: постачальник / склад, артикул і бренд, назва, «у каталозі», аналог, кількість
  («≥10», кратність), термін, ціна у валюті + в гривні, «Обрати» або причина, чому не можна;
- `components/ui/purchase-list/AutoAllocateDialog.tsx` — стратегія за замовчуванням з
  `GET /supplier-offers/settings`, прогрес пошуку, попередній перегляд (`dryRun`), «Перезаписати
  ручний вибір» (`overrideManual`, типово вимкнено), «Застосувати».

Хук — `hooks/api/useSupplierOffers.ts` (`refetchInterval`, поки є незавершені запити).

---

## Аспекти і тести, що їх стережуть

**Модуль:** `apps/api/src/modules/supplier-api/`

| Аспект                                                                                                                                                                                                                             | Тест                                    | Кейсів |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------ |
| нормалізація: кількість «>10» / «5+» / «>», ціна, дата, відкидання qty ≤ 0 і price ≤ 0 (BR-SOFR-001)                                                                                                                               | `adapters/adapter-utils.spec.ts`        | 14     |
| пошук: batch і запити, кеш у межах TTL, Redis недоступний, обробник, звірка з каталогом, дзеркало AVD, повтор о, ліміт, офлайн, задачі пачкою `addBulk`, відповідь з уже прочитаного, легкий стан для опитування (BR-SOFR-001…004) | `offers/supplier-offers.search.spec.ts` | 16     |
| ручний вибір: гривня за курсом, кратність, немає курсу, чужа пропозиція, CAS, зняття, аналоги за політикою, видимість цін (BR-SOFR-005, 006, 010)                                                                                  | `offers/supplier-offers.choose.spec.ts` | 25     |
| стратегії й покриття — вичерпні таблиці (BR-SOFR-007, 008)                                                                                                                                                                         | `strategy/offer-allocation.spec.ts`     | 15     |
| застосування автопідбору: dryRun, одна транзакція, поділ зі знімками, 409, ручний вибір і `overrideManual` (BR-SOFR-008, 009)                                                                                                      | `strategy/supplier-allocation.spec.ts`  | 12     |

Разом тут: **82** кейси.

Поза модулем: `settings/settings.contract.spec.ts` — поля налаштувань `supplier*` і межі (BR-SOFR-005, 007);
`purchase-lists/purchase-lists.offer-snapshot.spec.ts` — знімок за позицією (BR-PL-017, 019);
`purchase-lists/purchase-lists.create-orders.spec.ts` — рядки за пропозицією (BR-PL-018).
Контракти адаптерів (формати пропозицій кожного постачальника) — реєстр [supplier-connection.md](supplier-connection.md).
Web: `components/ui/purchase-list/__tests__/SupplierOffersDialog.test.tsx` (чипи «повтор о HH:MM» —
BR-SOFR-002, останні відомі — 003, ціни без ролі — 010), `AutoAllocateDialog.test.tsx` (`overrideManual`,
dryRun — BR-SOFR-009), `purchase-orders/__tests__/ItemsView.offers.test.tsx` (бейдж, ролі — BR-SOFR-003,
010), `hooks/api/useSupplierApi.test.tsx`. E2E — `apps/web/e2e/supplier-api.spec.ts`.
