# STO ERP / STO Service — Реєстр прогалин і ризиків

> Живий документ. Фіксує те, що ще не враховано в архітектурі/плані, щоб нічого не загубилось.
> Оновлювати при закритті прогалини або появі нової.

**Легенда статусу:** 🔴 відкрито · 🟡 в роботі / частково · 🟢 закрито
**Пріоритет:** Високий / Середній / Низький

---

## Критичне — до комерційного запуску

| ID  | Область        | Прогалина / ризик                                                                                                                  | Вплив                                                  | Пріор.           | Статус | ADR / Фаза               |
| --- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------- | ------ | ------------------------ |
| G1  | Дані           | Аварійне відновлення: бекапи лежать на тому ж сервері — не переживуть втрати диска, ransomware, крадіжки                           | Втрата всього бізнесу клієнта                          | Високий          | 🟡     | ADR-012                  |
| G2  | Безпека        | Унікальні секрети на інсталяцію: спільні JWT/DB/MinIO ключі = один витік валить усіх                                               | Компрометація всіх клієнтів                            | Високий          | 🟡     | ADR-012                  |
| G3  | Hub            | Експлуатація і безпека Service: керування приватним ключем (KMS/HSM), шифрування at-rest, моніторинг, власний DR/uptime            | Витік ключа = підробка ліцензій усіх; простій біллінгу | Високий          | 🔴     | ADR-013 (план)           |
| G4  | Комерція       | Онбординг/провіженінг: шлях install → реєстрація → trial → оплата; прив'язка інсталяції до акаунта Hub, доставка першої ліцензії   | Немає механізму продажів                               | Високий          | 🔴     | ADR-014 (план)           |
| G5  | Юридика        | EULA, Privacy Policy, DPA для синхронізованих даних, відповідність ЗУ «Про захист персональних даних», юрособа (ФОП/ТОВ) для шлюзу | Блокує легальний запуск                                | Високий          | 🔴     | ADR-015 / чекліст (план) |
| G6  | Підтримка      | Віддалена діагностика: офлайн-first → не видно зламану інсталяцію; немає opt-in збору логів і безпечного каналу підтримки          | Супровід неможливий                                    | Високий          | 🔴     | ADR (план)               |
| G7  | Інфраструктура | Патчинг хоста: авто-оновлення не чіпає Windows / WSL2 / Docker Engine у клієнта                                                    | Накопичення вразливостей ОС/runtime                    | Середній-Високий | 🔴     | доповнити ADR-009        |

## Важливе — невдовзі після запуску

| ID  | Область        | Прогалина / ризик                                                                            | Вплив                                | Пріор.   | Статус | ADR / Фаза              |
| --- | -------------- | -------------------------------------------------------------------------------------------- | ------------------------------------ | -------- | ------ | ----------------------- |
| G8  | Ліцензія       | Перенос ліцензії при зміні заліза + захист від клонування (дублювання VM з однією ліцензією) | Обхід ліцензії / незручність клієнту | Середній | 🔴     | доповнити ADR-008       |
| G9  | Спостережність | Opt-in телеметрія помилок (Sentry-подібна) — бачити збої до скарг                            | Реактивна підтримка                  | Середній | 🔴     | —                       |
| G10 | Mobile         | Логістика сторів: акаунти Google Play / Apple, платні dev-аккаунти, рев'ю, EAS build         | Затримка релізу мобільного           | Середній | 🔴     | Фаза 18                 |
| G11 | Онбординг      | Міграція даних від конкурентів (RemOnline тощо) при заведенні клієнта                        | Тертя при переході на продукт        | Середній | 🟡     | частково Фаза 16 (XLSX) |
| G12 | Дані           | Перевірені restore-drills: бекап без тесту відновлення = відсутній бекап                     | Бекап може не відновитись            | Середній | 🔴     | ADR-012                 |

## Менш термінове

| ID  | Область        | Прогалина / ризик                                                                      | Вплив                            | Пріор.  | Статус | ADR / Фаза        |
| --- | -------------- | -------------------------------------------------------------------------------------- | -------------------------------- | ------- | ------ | ----------------- |
| G13 | Ліцензія       | Edge-кейси downgrade: що з «зайвими» користувачами при зниженні грейда                 | Незручність / суперечки          | Низький | 🔴     | доповнити ADR-008 |
| G14 | Продуктивність | Capacity-guidance: скільки одночасних користувачів/нарядів тримає рекомендоване залізо | Невиправдані очікування          | Низький | 🔴     | —                 |
| G15 | Звітність      | Консолідована звітність по філіях через Hub                                            | Обмежена аналітика мережевих СТО | Низький | 🔴     | ADR-006           |

---

## Pre-prod ПОВТОРНИЙ огляд 2026-09-10 (5 складових, HEAD 4b74730e)

> Наскрізна перевірка після T-боргу + архітектури (A2/A3/A4/A5). Регресій від рефакторів НЕ виявлено
> (events behavior-preserving, VAT math-identical, registry/share live-verified). 2 блокери знайдено
> й ВИПРАВЛЕНО цим проходом. Дашборд: артефакт «STO ERP — Pre-Prod Re-Review».

**Виправлено:**

- 🟢 **T15 CRITICAL (fe91475e):** New-RandomBase64 крашив clean install на Windows PowerShell 5.1
  (статичний RandomNumberGenerator::GetBytes відсутній у .NET Framework) → .env не створювався.
  Fix: інстансний CSPRNG API. Verified на PS 5.1.26100.
- 🟢 **Frontend HIGH (4b74730e):** CreateWorkOrderModal FSM-transition інвалідував лише workOrdersKeys,
  не склад/баланс → після завершення наряду з модалки Залишки/Взаєморозрахунки stale. Fix: обидва
  call-site → invalidateWorkOrderSideEffects.

**Нові відкриті (не блокують запуск):**

| ID  | Область  | Знахідка                                                                                                  | Пріор.   | Статус |
| --- | -------- | --------------------------------------------------------------------------------------------------------- | -------- | ------ |
| R1  | DB       | CompletionAct пропущено в T14 partial-unique — plain @@unique блокує переюз номера після soft-delete      | Середній | 🟢     |
| R2  | Backend  | resolveApiKey where містить provider/enabled → тиха невідправка при зміні конфігу у вікні enqueue↔process | Середній | 🟢     |
| R3  | Frontend | SyncIndicator не бачить «локальний API down при browser online» (найімовірніший LAN-збій)                 | Середній | 🟢     |
| R4  | Security | .env.dev закомічено в git з реальним Sentry DSN (write-only, мінімальний ризик) → git rm --cached         | Низький  | 🟢     |
| R5  | Deploy   | PS-скрипти без лінту/Pester у CI (причина пропуску T15) — додати windows smoke                            | Низький  | 🟢     |

**Закрито після цього огляду (34e2fb63):** 🟢 T16 (compose mem_limit/cpus + web/caddy healthcheck),
🟢 T23 (Backup/Restore docker cp + --clean --if-exists — без BOM, шлях відновлення протестований),
🟢 T12 (followup cursor-пагінація). **Docker tag-mismatch — вже закрито раніше (1e1aca97):** compose
локальні теги sto-api/web:${VERSION}, Setup-Stack/-Version, setup.iss -Version {#AppVersion}, Update.ps1
rollback на локальні теги + Bug #716 same-tag guard, release.yml local build+save (без ghcr push),
minio pinned tag compose↔release. **Лишається (deploy-борг, поза scope):** T4 (Docker Desktop↔WSL2
ADR-розрив). Комерційні GAPS G1-G7 — блокують легальний запуск, не технічний MVP.

---

## Технічний борг — pre-prod аудит 2026-09-09 (6 складових, HEAD fdb468df)

> Наскрізний аудит backend/frontend/DB/security/deploy/quality. Ядро (гроші/склад/FSM/tenant/безпека/БД)
> прод-готове (0 нових CRITICAL/HIGH у коді). 4 блокери деплою/збірки знайдено та **закрито** тим самим
> проходом. Нижче — решта. Повний зведений звіт: артефакт «STO ERP — Pre-Prod Readiness».

**Закриті блокери (fdb468df):** T-B1 api MINIO-env crash · T-B2 offline-update (docker load) · T-H1
frontend E2E auth-hatch build-gate · T-M-tsc mobile experimentalDecorators · T-H3 Stop-Stack ярлик.

**Опрацьовано (2026-09-09, «робимо все окрім інсталу», коміти 4cc9d156…a1318072):** 🟢 закрито
T1/T2 (ESLint api/web/mobile + CI-гейти), T6/T7/T8 (SSE revocation, MinIO policy, apiKey поза Redis),
T3/T9/T10 (offline-меседж, dashboard-помилки, supplier-return invalidate), T5/T14 (sync-індекси,
partial-unique номерів), T13 (maintenanceForecastDays у settings), T11 (client-side Zod), T18 (docs
дос'є loyalty/maintenance/payments), T19 (Kyiv-TZ + ₴ + tabular-nums), T17 (E2E money-flow, 9 тестів),
T24 (loyalty.processor spec), T12 (followup cursor-пагінація — прибрано тиху втрату нагадувань >1000),
T15 (New-RandomBase64 PS 5.1 instance-API), T16 (compose mem_limit/cpus + web/caddy healthcheck),
T23 (Backup/Restore docker cp + --clean --if-exists — без BOM), Docker tag-mismatch (1e1aca97 —
локальні теги + rollback + Bug #716 guard). 🔴 Deploy-борг, що лишається: T4 (Docker Desktop→WSL2 ADR).
Свідомі non-fix:
T20 (документовані recoverable tx-tradeoff), T21 (login MinLength — підняття залокаутило б наявних
юзерів; refresh TTL/sessionStorage — design-tradeoff з security-аудиту), T22 (Float→Decimal — важка
міграція; historical DROP INDEX — безпечний у лінійній історії).

| ID  | Область  | Прогалина / ризик                                                                                                                                                                                                                                                                                                                                                                                                                                      | Пріор.   | Статус |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| T1  | Tooling  | Backend (api/mobile) не лінтиться — немає ESLint-конфігу; 57 модулів без статичного лінту                                                                                                                                                                                                                                                                                                                                                              | Високий  | 🟢     |
| T2  | CI       | CI = лише migration-safety; type-check/lint/unit/e2e не в CI → регресії не ловляться до релізу                                                                                                                                                                                                                                                                                                                                                         | Високий  | 🟢     |
| T3  | Frontend | Offline-first для ЗАПИСУ не реалізований — SW не чергує /api, pending_ops обнуляється без replay                                                                                                                                                                                                                                                                                                                                                       | Високий  | 🟢     |
| T4  | Deploy   | Install ↔ ADR-002/003 розрив: Docker Desktop замість WSL2-engine; port-proxy скрипти відсутні                                                                                                                                                                                                                                                                                                                                                          | Високий  | 🔴     |
| T5  | DB       | 3 PULL-таблиці (WorkOrderLine/WorkOrderPart/Payment) без @@index([orgId,syncVersion]) → sort у sync                                                                                                                                                                                                                                                                                                                                                    | Високий  | 🟢     |
| T6  | Security | Dashboard SSE: токен у query-log + revocation-bypass (не перевіряє tokenVersion)                                                                                                                                                                                                                                                                                                                                                                       | Середній | 🟢     |
| T7  | Security | MinIO публічний anonymous read на org/* (фото/документи клієнтів) — висить 2 цикли                                                                                                                                                                                                                                                                                                                                                                     | Середній | 🟢     |
| T8  | Security | apiKey розшифрований plaintext у Redis job payload; Redis без пароля                                                                                                                                                                                                                                                                                                                                                                                   | Середній | 🟢     |
| T9  | Frontend | Dashboard проковтує помилки → 0/«нема даних» замість реального стану (silent wrong number)                                                                                                                                                                                                                                                                                                                                                             | Середній | 🟢     |
| T10 | Frontend | Supplier-return confirm не інвалідує склад+баланс → застарілі дані                                                                                                                                                                                                                                                                                                                                                                                     | Середній | 🟢     |
| T11 | Frontend | Client-side Zod-валідація відсутня — shared-схеми не імпортуються                                                                                                                                                                                                                                                                                                                                                                                      | Середній | 🟢     |
| T12 | Backend  | followup-processor cap 1000 → тиха втрата ТО-нагадувань для автопарків >1000                                                                                                                                                                                                                                                                                                                                                                           | Середній | 🟢     |
| T13 | Backend  | MAINTENANCE_FORECAST_DAYS=14 хардкод — не в OrganisationSettings                                                                                                                                                                                                                                                                                                                                                                                       | Середній | 🟢     |
| T14 | DB       | Немає DB-unique (orgId, number) на документах → дублі номерів у offline/restore (юрид. ризик)                                                                                                                                                                                                                                                                                                                                                          | Середній | 🟢     |
| T15 | Deploy   | New-RandomBase64 некоректна PS-логіка → секрети можуть виходити слабкими                                                                                                                                                                                                                                                                                                                                                                               | Середній | 🟢     |
| T16 | Deploy   | compose: resource-limits ✅ + web/caddy healthcheck ✅ (non-root user контейнерів — окремий hardening)                                                                                                                                                                                                                                                                                                                                                 | Середній | 🟢     |
| T17 | Quality  | E2E-прогалина money-flow: нема UI-тесту оплати/каси/фіскал-чека                                                                                                                                                                                                                                                                                                                                                                                        | Середній | 🟢     |
| T18 | Docs     | Нові фічі (loyalty/ТО-нагадування/payments-об'єкт) без досьє в docs/objects                                                                                                                                                                                                                                                                                                                                                                            | Середній | 🟢     |
| T19 | Frontend | Дати не прив'язані до Kyiv-TZ · ₴ vs грн · tabular-nums відсутній · Escape закриває вкладені модалки                                                                                                                                                                                                                                                                                                                                                   | Низький  | 🟢     |
| T20 | Backend  | online-payment polling без auto-recovery · WO INVOICED→PAID поза tx · post-commit side-effects поза tx                                                                                                                                                                                                                                                                                                                                                 | Низький  | 🔴     |
| T21 | Security | login MinLength(4) · refresh TTL 30d · access у sessionStorage · secure-cookie на LAN-HTTP                                                                                                                                                                                                                                                                                                                                                             | Низький  | 🔴     |
| T22 | DB       | Кількості на Float (drift у FIFO/FEFO) · DROP INDEX без IF EXISTS у червневій міграції                                                                                                                                                                                                                                                                                                                                                                 | Низький  | 🔴     |
| T23 | Deploy   | Backup UTF-8 BOM · Restore без DROP/CREATE ✅ · (VERSION-tag/rollback → окремий Docker-tag фікс)                                                                                                                                                                                                                                                                                                                                                       | Низький  | 🟢     |
| T24 | Quality  | loyalty.processor без spec · E2E seed #564 крихкий · 3 змістовні TODO (autoArchive/cursor/XLSX)                                                                                                                                                                                                                                                                                                                                                        | Низький  | 🟢     |
| T25 | Backend  | GoodUoM.coefficient напрямок конверсії неоднозначний: код `base = qty / coeff` (divisor-конвенція, узгоджено addPart/share/export/stock), але семантика «1 пак = N шт» дала б `× coeff` → потребує продуктового уточнення (pre-existing, не A3; знайдено tester-агентом при A3-огляді)                                                                                                                                                                 | Низький  | 🔴     |
| T26 | Quality  | E2E estimate-share+work-orders-features 13 фейлів → діагноз: 12 = web-сервер БЕЗ NEXT_PUBLIC_E2E=1 (auth-hatch off → login-redirect; не тест/код-баг, а dev-setup); 1 = РЕАЛЬНИЙ backend-баг (findOne goodUoM.findMany без orgId → tenant-guard 500 на WO з UoM-part, 52a34fc4). Обидва виправлено, 16/16 green. **Урок:** E2E ганяти лише з NEXT_PUBLIC_E2E=1 (playwright webServer вмикає, але reuseExistingServer:true переюзає плоский dev-сервер) | Низький  | 🟢     |

**npm audit:** 51 vuln (2 crit, 25 high) — переважно transitive DoS (tar/js-yaml/image-size/find-my-way)

- fastify-middleware-bypass advisories. Наш auth — на Nest-guards (не middie), тож middie-bypass прямо
  не застосовний; @nestjs/platform-fastify trailing-slash/URL-encoding bypass потребує окремої оцінки.

**Рекомендований порядок (закрито):** T3 → T1/T2 → T6/T7/T8 → T15/T16/T23 (deploy) → T9/T10/T11 →
T12 (followup scale) + Docker tag-mismatch (1e1aca97). **Лишається:** T4 (WSL2 ADR), T20/T21/T22 (LOW).

---

## Архітектурний борг — OOP-аудит 2026-09-09 (3 незалежні аудити, оцінка 7/10)

> Погляд архітектора коду. Зріла service-layer ООП вище середнього: Registry+Strategy для 4 провайдерів,
> aspect-oriented Prisma-extensions, інкапсульовані грошові/складські інваріанти, майже ациклічний граф.
> Борг зростання — не концептуальні помилки. Дашборд: артефакт «STO ERP — Архітектурна зрілість».

| ID  | Покращення                                                                                                                                                                                                            | Пріор.   | Статус |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| A1  | Tenant-ізоляція: ALS + Prisma-guard (fail-closed) — ловить пропуски orgId, тихий витік→гучний збій                                                                                                                    | Високий  | 🟢     |
| A2  | Доменні events для lifecycle side-effects (WorkOrderCompleted + @OnEvent, +outbox)                                                                                                                                    | Високий  | 🟢     |
| A3  | Розбити God-об'єкти: WO-service 2124→1595р (Share✅+Events✅+StockEffects✅); CreateWorkOrderModal 3708→3325р (useReferenceData✅+useStockTotals✅+useWorkOrderActions✅; лишаються WorksTable/PartsTable — moderate) | Високий  | 🟡     |
| A4  | Provider-registry через multi-provider DI-токен замість конкретних класів (OCP+DIP)                                                                                                                                   | Середній | 🟢     |
| A5  | Спільний DTO/FSM-контракт у @sto/shared (Zod через nestjs-zod) — усунути ручне дзеркалення                                                                                                                            | Середній | 🟢     |

**A5-money закрито (a465f20b):** формула ПДВ (calcVatOnBase) — єдине джерело у common/utils/vat;
WO.recalcTotals + invoices.lineVatTotals делегують. Прибрано 3-ю inline-копію (drift-ризик грошей).

**A1 закрито (c6a1a9eb, guard-підхід замість повної заміни):** обрано defense-in-depth, а не переписування
1828 ручних where:{orgId}. AsyncLocalStorage-міст (interceptor кладе request.user.orgId у scope) + Prisma
$extends guard (OUTERMOST), що КИДАЄ TenantIsolationError, якщо запит на tenant-модель іде без orgId/branchId
у where, або create без orgId. Ручні where лишились (коректні) — guard ловить МАЙБУТНІ пропуски (тихий
крос-tenant витік → гучний 500). Exempt: 6 junction + PricingRuleTier/WebhookDelivery/LoyaltyTransaction/
SystemTemplate + Organisation (self-tenant). branchId = валідний tenant-токен (FK→branch→org). Легітимні
глобальні запити (login/setup/share/cross-org) + 12 процесорів обгорнуто у runUnscoped/runWithTenant (await
ВСЕРЕДИНІ scope — lazy-PrismaPromise назовні виконався б поза scope). Реальне покриття — інтеграційний spec
проти живої БД (юніти мокають Prisma → guard не фаєрить). Raw-SQL (~17) поза guard (мають orgId у SQL-тексті).
Boot-smoke чистий (login→CRUD→reports→payments 200, 0 TenantIsolationError).

**A5 закрито (98bbe7a8):** gate-множини (EDITABLE/SHAREABLE/INVOICEABLE) з єдиним джерелом у
@sto/shared (backend імпортує); FSM-transition-мапа під regression-guard (fsm.contract.spec). nestjs-zod DTO-міграція — окремий фоллоу (більший обсяг).

**A3 частково (dcb413b3):** WorkOrderShareService винесено (share/public-кошторис); WorkOrdersService
2085→1850 рядків, fan-out 11→7. Лишається: StockEffects + TotalsCalculator екстракції.

**A2 закрито (cc446ba7):** transition() емітить WorkOrderTransitioned/Completed події; 5 inline
side-effects → @OnEvent-хендлери. Fan-out WorkOrdersService 11→9. Live-verified (audit-count 3→4).

**A4 закрито (1e427074):** 4 registry (fiscal/gateway/notification/delivery) → DI-токен + single-factory
масив singleton-ів (NestJS 10 не має Angular-style `multi:true`). Live-verified усі 4 endpoint-и.

---

## Порядок опрацювання (рекомендований)

1. **ADR-012** — унікальні секрети + аварійне відновлення (G1, G2, G12). Дешево, блокує запуск.
2. **ADR-014** — онбординг/провіженінг (G4). Комерційний хребет.
3. **ADR-013** — експлуатація і безпека Hub (G3).
4. **ADR-015 / чекліст** — юридично-комерційний каркас (G5).
5. Доповнення: ADR-008 (G8, G13), ADR-009 (G7), підтримка/телеметрія (G6, G9).
