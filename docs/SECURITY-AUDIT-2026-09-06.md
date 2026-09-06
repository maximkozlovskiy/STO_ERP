# Security Audit — 2026-09-06 (pre-production)

Комплексний аудит безпеки коду перед прод-релізом. Чотири напрямки:
dependency CVE, tenant-ізоляція (orgId), auth/JWT+secrets, broad appsec.

## Baseline (швидкі grep-перевірки — усе чисто)

- ❌ Захардкоджених секретів у коді немає (лише `.env.example` з плейсхолдерами).
- ❌ `eval` / `new Function` немає.
- ✅ Єдиний `dangerouslySetInnerHTML` (`apps/web/src/app/layout.tsx`) — **статичний**
  theme-скрипт (localStorage color-mode), без інтерполяції даних → безпечно (анти-FOUC).
- ✅ Raw SQL лише в `reports.service.ts` через `Prisma.sql` з **параметризованими**
  `${x}::uuid` (не string-concat) → injection-safe.
- ✅ `helmet`, CORS (`WEB_ORIGIN` env), ThrottlerModule (200/60с), `@fastify/cookie` присутні.

---

## 1. Dependency CVE (`pnpm audit --prod`)

**110 вразливостей: 3 critical / 63 high / 38 moderate / 6 low.**

### Триаж за досяжністю у прод-runtime (API/web on-prem)

| CVE                                                                       | Пакет                   | Шлях                                                                | Runtime?                      | Вердикт                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GHSA-72c6-fx6q-fr5w (auth-bypass)                                         | `@fastify/middie@8.3.3` | api → @nestjs/platform-fastify                                      | **API runtime**               | **Практично НЕДОСЯЖНА** — CVE про auth у middleware child-scopes; тут auth через **Guards** (`@UseGuards`/`CanActivate`), єдиний middleware — `CorrelationIdMiddleware` (лише request-id, без auth). Патч (9.3.2+) вимагає **Fastify 5** (проєкт на Fastify 4 через `fastify-plugin@4`) → безпечний фікс лише разом із міграцією на Fastify 5. **Не блокер, задокументувати.** |
| shell-quote, node-tar, xmldom, stream-json, @babel/core + ~більшість high | transitive              | **apps/mobile → expo → react-native → react-devtools-core / metro** | **dev/build-tooling мобілки** | Не входять у on-prem API/web runtime, що доставляється на СТО. Пріоритет нижчий; трекати, оновити разом з Expo SDK.                                                                                                                                                                                                                                                            |

**Дії:**

- (реком.) Планова міграція `@nestjs/platform-fastify` → v11 + Fastify 5 закриє middie CVE «за побудовою». Окрема задача (breaking).
- (реком.) `pnpm why shell-quote` тощо — оновити Expo SDK у mobile для закриття dev-tooling CVE.
- Додати `pnpm audit --prod --audit-level high` у CI, щоб нові runtime-CVE не проходили тихо.

---

## 2. Tenant-ізоляція (orgId)

### ✅ ЧИСТО — жодної CRITICAL/HIGH вразливості

Систематично протрасовано: 60 сервіс-файлів, ~593 reads, ~120 мутацій, 11 findUnique
(усі org-scoped unique-ключі, **жодного** bare `findUnique({id})` → IDOR-вектора немає),
15 raw-SQL сайтів (усі з `"orgId"=${orgId}::uuid` + параметризовані), усі creates (orgId з
`@OrgContext`, ніколи з DTO — усі `orgId!` лише у Response-DTO), public-endpoints
(share-token 128-bit, minimal DTO; booking деривує org з branchId), sync (org-scoped +
FK-validation проти cross-tenant injection). Trust-root `@OrgContext` = `req.user.orgId` з
**підписаного** JWT, не клієнт-контрольований. Усі 50+ модулів — CLEAN.

### 🟡 LOW (hardening, не live-vuln)

~11 bare-id мутацій (brands/currencies/exchange-rates/payment-methods/units restore;
goods:528/610; invoices:526; PO:810; WO:937) — id завжди з upstream org-scoped fetch, тож
не досяжні cross-tenant, АЛЕ конвертувати у composite `where:{id,orgId}` /
`updateMany({where:{id,orgId}})` захистить від майбутнього рефактору, що прибере upstream-guard.

## 4. Broad appsec

### ✅ Зроблено добре / verified CLEAN

SQL-injection — 0 (усе `Prisma.sql` параметризоване, `q` length-bounded); SSRF — thorough
`url-guard` (RFC1918/loopback/link-local/169.254.169.254/IPv6) на webhooks+checkbox +
`redirect:'manual'`; mass-assignment — `ValidationPipe{whitelist,forbidNonWhitelisted}`,
DTO не експонують orgId/isSystem/balance/status/id; public share-token 128-bit + minimal DTO;
file-upload — server MIME+ext allowlist (без svg/html), sanitizeFilename (анти-traversal),
server-UUID object-key; XSS — лише статичний theme-скрипт; error-filter не віддає stack/SQL.

### 🟠 #1 CSV formula-injection (MEDIUM) — ВИПРАВЛЕНО

Client-експорти (settlements/reports/report-builder) писали user free-text у CSV без guard →
`=HYPERLINK(...)`/`=cmd|...` у примітці контрагента виконувалось при відкритті у Excel.
**Fix:** новий `escapeCsvCell()` (`lib/utils.ts`) — префікс `'` перед `=+-@`/TAB/CR + CSV-квотування;
застосовано у reports `buildCsv` (6×), settlements-export, ReportBuilder CSV. +тест 5 кейсів.

### 🟠 #2 XLSX estimate-export formula-injection (MEDIUM) — ВИПРАВЛЕНО

Публічний `GET /public/work-orders/:token/export/xlsx` писав orgName/branchName/line.name/
part.name/description у клітинки без guard. **Fix:** `xlsxSafe()` у
`work-orders-export.service.ts` — префікс `'` для рядків-лідерів формул; застосовано до всіх
user-sourced string-клітинок. (XLSX-XML path у ReportBuilder безпечний — `ss:Type="String"`.)

### 🟠 #3 MinIO public-read bucket policy `org/*` (MEDIUM) — ЗАДОКУМЕНТОВАНО, потребує рішення

`files.service.ts onModuleInit` ставить анонімний `s3:GetObject` на `org/*` → усі завантажені
файли world-readable за передбачуваним шляхом (`org/<orgId>/work-orders/<woId>/<uuid>.<ext>`).
work-order-media вже віддає **presigned URL** (тож для медіа public-policy зайвий), АЛЕ
org-логотипи (`files.upload`) віддаються **raw public URL** для `<img src>`. Прибрати policy
наосліп → зламає логотипи. **Рекомендація (потребує продуктового рішення):** або (а) звузити
public-policy до `org/*/logo/*` і лишити медіа presigned-only, або (б) проксувати логотипи
через auth-роут. UUID-ключі (122-bit) роблять enumeration непрактичним → MEDIUM, не блокер.
**Не виправлено цю сесію** — зміна з UX-впливом на показ логотипів, потребує узгодження.

---

## Підсумок дій

| #                              | Severity    | Статус                                                               |
| ------------------------------ | ----------- | -------------------------------------------------------------------- |
| H-1 default admin123 у prod    | CRITICAL    | ✅ ВИПРАВЛЕНО (seed-guard + installer)                               |
| #1 CSV formula-injection       | MEDIUM      | ✅ ВИПРАВЛЕНО (escapeCsvCell + тест)                                 |
| #2 XLSX formula-injection      | MEDIUM      | ✅ ВИПРАВЛЕНО (xlsxSafe)                                             |
| H-2 ПРРО/SMS plaintext at-rest | HIGH        | 🟠 TODO — AES-256-GCM at-rest (окрема задача)                        |
| #3 MinIO public bucket         | MEDIUM      | 🟠 TODO — потребує продуктового рішення (логотипи)                   |
| M-1..M-5 (auth hardening)      | MEDIUM      | 🟠 TODO — owner-пароль ≥12, refresh revocation, TTL, in-memory token |
| orgId bare-id мутації          | LOW         | 🟢 Nice-to-have hardening                                            |
| Dependency middie CVE          | (недосяжна) | 🟢 з Fastify 5 migration                                             |

**Tenant-ізоляція — CLEAN.** Три вразливості виправлено цю сесію (1 CRITICAL + 2 MEDIUM).
Решта — задокументована з рекомендаціями; H-2 (шифрування секретів) — найпріоритетніша з TODO.

## 3. Auth / JWT / secrets

### ✅ Зроблено добре (не чіпати)

bcrypt cost=12 усюди; окремі JWT_ACCESS/REFRESH секрети через `getOrThrow` (без fallback,
без `none`, `ignoreExpiration:false`); **інсталятор ГЕНЕРУЄ унікальні секрети per-СТО**
(`Setup-Stack.ps1` — RNG 48 байт, `.env` лише якщо ще нема); login throttle 10/60с;
`/auth/refresh` cookie-protected + rotation; httpOnly+sameSite:strict+secure refresh-cookie;
setup TOCTOU-safe (advisory lock + in-tx re-check); паролі не витікають у відповідях; логи
редагують password/token поля.

### 🔴 H-1 (CRITICAL) — ВИПРАВЛЕНО

Інсталятор (`First-Run.ps1`) запускав demo-`seed.ts` **беззастережно у production** →
кожен СТО отримував однаковий загальновідомий OWNER-логін `admin@sto.local / admin123`
(навіть логувався). Будь-хто в LAN логінився як OWNER.
**Fix:** (1) `seed.ts` `main()` відмовляється при `NODE_ENV=production` (крім `ALLOW_DEV_SEED=1`
для dev/E2E); (2) `First-Run.ps1` більше не викликає `db seed` — реальну org+OWNER створює
оператор через майстер `/setup` (уже існує, форсить пароль оператора, bcrypt-12).
Верифіковано: dev seed працює, prod відмовляє, override працює.

### 🟠 H-2 (HIGH) — до виправлення

ПРРО (Checkbox) `checkboxLicenseKey`/`checkboxPinCode` + `smsApiKey` зберігаються
**PLAINTEXT** у Postgres (`schema.prisma` — plain String?; settings.service пише `...dto`
напряму; читаються raw у checkbox.processor/notifications). Шифрування at-rest НЕ реалізовано
(попри CLAUDE.md claim). Дамп БД/бекап → витік фіскальних+SMS-секретів. (Плюс: НЕ віддаються
у API-відповідях — `mapBranchSettings` їх омітить.) **Fix:** AES-256-GCM at-rest з ключем із
окремого per-install env-секрету; дешифрувати лише в point-of-use.

### 🟡 Medium (до розгляду)

- **M-1** owner-пароль `@MinLength(6)` (login DTO — 4) → підняти до ≥12 + complexity.
- **M-2** refresh stateless — не відкликається на logout/компрометацію (немає session-table/jti).
- **M-3** refresh TTL 30d — задовго для фін-ERP → ~7d (після M-2).
- **M-4** access-token у `sessionStorage` (XSS-exfil, 15хв вікно) → in-memory + CSP (refresh
  httpOnly вже захищає головний credential — прийнятно).
- **M-5** `New-RandomBase64` (installer) — крихкий pipeline (працює, але footgun) → переписати.

## 4. Broad appsec — _[заповнюється агентом]_

## 4. Broad appsec (input/upload/public/mass-assignment/XSS/SSRF) — _[заповнюється агентом]_
