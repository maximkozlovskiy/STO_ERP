# sto-tester — повні тексти пунктів §1.4 — Security (FULL режим)

> Не читати цілком. Перелік пунктів — `../sections/s1-4-security.md`; звідси беруться лише
> ті, чий код `T1.4-NNN` обрано за diff-ом.

<!-- T1.4-001 -->

- [ ] **Paired SSRF defense (Bug #273):** `validatePublicUrl` (defense-in-depth #1) АБО `redirect: 'manual'` (defense-in-depth #2) **окремо** = частковий захист. ОБИДВА обов'язкові. Атакувальник з admin правом може поставити `branchSettings.checkboxApiUrl = "https://attacker.com"` (proxy legit external), і attacker.com відповідає `302 Location: http://169.254.169.254/...` → default fetch слідує redirect у cloud metadata з Authorization header. Webhooks вже мають обидва шари; будь-який новий outbound fetch (Checkbox, ПРРО, SMS provider, OAuth callback, postal API) автоматично має мати обидва. Grep: для кожного `fetch(...)` де URL = ${branchSettings.X}/${dto.X}/${cfg.X}/${endpoint.X} — перевірити (а) URL пройшов validatePublicUrl у тому ж scope; (б) options має `redirect: 'manual'`; (в) response.status у [300,400) → throw. Парне з контракт-тестом (checkbox.processor.spec.ts pattern: `301/302 → throw + НЕ оновлює DB`). Severity: CRITICAL (production SSRF, admin → cloud metadata access)

<!-- T1.4-002 -->

- [ ] **Public endpoint double-strict audit (Bugs #251 + #252):** для КОЖНОГО controller-методу без `@UseGuards(JwtAuthGuard)` (повний клас без guard АБО handler з `@Public()`):
  - КОЖЕН `@IsArray()` поле у відповідному DTO має `@ArrayMaxSize(N)` (без cap — HIGH bug, ValidationPipe виконає N×regex до 400)
  - КОЖЕН `string[]` / `UUID[]` поле що зберігається у service-create-методі через `data: { ...dto, fkList: dto.field }` має ПЕРЕД create-викликом виконуватись tenant-FK guard `prisma.X.count({ where: { id: { in: dto.field }, orgId, deletedAt: null } })` з порівнянням `count === dto.field.length` (без guard — HIGH bug, cross-tenant linkage у БД)
  - КОЖЕН `@IsString()` поле без `@MaxLength` — anti-DoS gap
  - Якщо викликається external service (SMS, ПРРО) — queue з attempts ≥ 10 + exponential backoff (offline-first invariant)

<!-- T1.4-003 -->

- [ ] **Secret at-rest via Prisma `$extends` (Bug #652):** якщо секрет (apiKey/licenseKey/pinCode/token) шифрується розширенням `withFieldEncryption` (encrypt-on-write/decrypt-on-read) — ОБОВ'ЯЗКОВО перевірити:
  - (а) **Integration-тест наскрізного циклу проти живої БД** (не лише unit round-trip crypto-хелпера). Будувати клієнт ТОЧНО як `PrismaService.onModuleInit` (та сама композиція розширень, той самий порядок). Довести: raw `$queryRawUnsafe` колонки = `enc:v1:`+не містить plaintext; read через розширення = plaintext; legacy-plaintext рядок (raw INSERT) читається без змін; update без секрету не робить подвійне шифрування. Guard skip якщо БД down, але реально біжить коли є (не fake-green). uuid-bind у raw кастити `$1::uuid`.
  - (б) **Consumer читає розшифроване:** кожен провайдер-виклик / external-API header що споживає секрет читає його через РОЗШИРЕНИЙ client (`this.prisma`), НЕ через `new PrismaClient()` чи `$queryRaw`. Grep: `grep -rn "new PrismaClient" apps/api/src --include="*.ts" | grep -v "spec\|prisma.service"` = 0; `grep -rniE "queryRaw.*(apiKey|licenseKey|pinCode|secret|token)" apps/api/src` (не spec) = 0.
  - (в) **Секрет не витікає:** response-DTO-мапер / Redis-кеш / sync-експорт НЕ включають розшифроване поле (лише `hasX`-прапорець). Мапер має явно омітити секрет; sync PULL/PUSH tables мають виключати таблиці-носії секретів.
  - (г) **`where`-фільтр на зашифрованій колонці** — лише null-checks (`{ not: null }`) валідні (індиферентні до шифрування); `equals/contains/startsWith/in` на ciphertext-колонці = завжди-промах (баг). Grep: `grep -rnE "(apiKey|smsApiKey|licenseKey|pinCode):\s*\{?\s*(equals|contains|startsWith|in)" apps/api/src --include="*.ts" | grep -v spec`.
