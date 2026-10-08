# sto-tester — §1.5 — Тест-покриття Backend

> Частина скіла `sto-tester`. Алгоритм і матриця — у `../SKILL.md`.
> Це ПОВНИЙ перелік пунктів секції: короткі — дослівно, довгі — заголовком із кодом
> `T1.5-NNN`. Прочитай файл цілком, познач пункти, що стосуються diff-у, і дістань їхній
> повний текст (сигнал, grep-детектор, фікс) із `../journal/details-1-5.md`:
>
> ```bash
> awk '/T1.5-(007|012) -->/{f=1;next} /<!-- T1\./{f=0} f' .claude/skills/sto-tester/journal/details-1-5.md
> ```

### §1.5 — Тест-покриття Backend

- [ ] Змінено `scripts/affected-tests.py` або додано тест нового виду (Bugs #785–#788) — `T1.5-001`

```bash
# Contract тести
find apps/api/src -name "*.contract.spec.ts" | sort

# Property-based тести
find apps/api/src -name "*.invariants.spec.ts" | sort

# Unit тести нових сервісів
git diff HEAD --name-only | grep "service.ts" | while read f; do
  spec="${f%.ts}.spec.ts"
  [ -f "$spec" ] && echo "OK: $spec" || echo "MISSING spec: $spec"
done

# Новий external-API HTTP-клієнт/gateway з fetch — ЗАВЖДИ потребує власного spec (Bugs #683-#687).
# Processor-spec мокає клієнт цілком → SSRF/timeout/auth-header/3xx/401 клієнта невидимі CI.
for f in $(git diff HEAD --name-only | grep -E "client\.ts$|gateway\.ts$|provider\.ts$"); do
  grep -q "fetch(\|axios\." "$f" 2>/dev/null && { [ -f "${f%.ts}.spec.ts" ] || echo "MISSING client spec (external-API): $f"; }
done

# Стала spec після рефактору — нова constructor-залежність не замокана у TestingModule
# (NestJS DI fail "Nest can't resolve dependencies ... at index [N]")
for svc in $(git log --oneline -10 --name-only | grep "service.ts$" | sort -u); do
  spec="${svc%.ts}.spec.ts"
  [ -f "$spec" ] || continue
  # кожен private readonly у конструкторі сервісу має бути provided у спеці
  deps=$(grep -oE "private readonly [a-zA-Z]+: [A-Z][a-zA-Z]+" "$svc" | grep -oE ": [A-Z][a-zA-Z]+" | tr -d ': ')
  for d in $deps; do
    grep -q "$d" "$spec" || echo "STALE SPEC $spec: missing provider/mock for $d (constructor dep of $svc)";
  done
done

# Застарілий mock-call-count: сервіс спрощено до 1 findFirst, але spec мокає двічі
grep -rn "mockResolvedValueOnce(null)" apps/api/src --include="*.spec.ts" -A1 | grep "mockResolvedValueOnce" | head -10
# → для кожного звірити кількість findFirst у відповідному service.create()/update()

# Query-shape фікс (relation-ім'я / nested where) БЕЗ service-spec (Bug #163)
# fix-commit що змінює relation-ім'я або форму вкладеного where → contract spec мокає сервіс → НЕ ловить
git log --oneline -15 | grep -iE "PrismaClientValidationError|relation|nested|where|search|q=" | head
# для кожного fix що чіпав where/include/relation: чи є service-spec що асертить реальний where через Prisma-мок?
for svc in $(git log --oneline -15 --name-only | grep "service.ts$" | sort -u); do
  spec="${svc%.ts}.spec.ts"
  if grep -lq "PrismaService, useValue: {}" "${svc%/*}"/*.contract.spec.ts 2>/dev/null && [ ! -f "$spec" ]; then
    echo "QUERY-SHAPE GAP: $svc змінено, contract мокає сервіс, service-spec відсутній";
  fi
done
```

**Стала spec після рефактору сервісу (Bug #153-#155):**

- [ ] Кожен `private readonly X: Type` у конструкторі сервісу → є `{ provide: Type, useValue: mock }` у `Test.createTestingModule({ providers })` спеки (інакше NestJS DI fail на всіх тестах файлу)
- [ ] Кеш-мок: `CacheService.get` → `mockResolvedValue(null)` (cache miss → fallthrough на БД); `set/del/delPattern` → no-op
- [ ] Якщо `service.create()/update()` спрощено з N `findFirst` до 1 (single round-trip resurrection/dup-check) → spec мокає `findFirst` РІВНО стільки разів скільки реальних викликів (не успадкований `mockResolvedValueOnce(null).mockResolvedValueOnce(...)`)
- [ ] Defense-in-depth status guard + stale fixtures (Bug #200) — `T1.5-002`
- [ ] Refactored public method usage + stale mock (Bug #200) — `T1.5-003`
- [ ] Controller arg-count drift у `toHaveBeenCalledWith` форвардингу (Bug #340) — `T1.5-004`
- [ ] Stale mock після додавання cascade-helper у service-method (Bug #340) — `T1.5-005`

- [ ] Dedup invariant додано після simplify-to-Promise.all БЕЗ regression-guard (Bug #489) — `T1.5-006`

- [ ] Widened return-type service method + stale 2-field mock/assert у paired spec (Bug #508-#509) — `T1.5-007`

- [ ] Stale `$transaction` callback mock (Bug #489 sub-pattern; зразок мока і grep — одразу під пунктом, у журналі їх нема) — `T1.5-008`

```ts
$transaction: vi.fn().mockImplementation((arg: unknown) => {
  if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
  if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
  return Promise.resolve(arg);
}),
```

Grep: для кожного `$transaction(async ... =>` у service.ts → у парному spec.ts шукати `$transaction:.*async\s*\(\s*ops`/`async\s*\(\s*op` (старий array-only мок) → bug. Severity HIGH (стирає весь test-coverage внутрішнього $transaction body — інші regression-guard checklist items неефективні).

**Query-shape фікс потребує service-spec, не contract-spec (Bug #163):**

- [ ] Fix що змінив **relation-ім'я** (`customerGarage`→`customerGarages`), **форму вкладеного `where`** (`some`/`every`/nested `OR`), `include`/`select` shape, або `mode — `T1.5-009`

**Обов'язкові contract тести для нових endpoints:**

- `GET /X` → 200 + `{ items, total }`; 401 без токена
- `POST /X` без обов'язкових полів → 400
- `PATCH /X/:id` з чужим orgId → 404

**Обов'язкові unit тести:**

| Сервіс                      | Критичні кейси                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `work-orders.service`       | create→DRAFT; FSM invalid→throws; IN_PROGRESS→RESERVATION; COMPLETED→WRITEOFF+CHARGE  |
| `inventory.service`         | RECEIPT +qty; RESERVATION -available; WRITEOFF insufficient→throws; qty=0→throws      |
| `settlements.service`       | CHARGE +balance; PAYMENT -balance; no account→NotFoundException                       |
| `auth.service`              | login OK; wrong password→401; deleted employee→401; invalid refresh→401               |
| `pricing.service` COST_TIER | tiers=[]; cost=0; cost===tier.costMax (boundary half-open); cost<минімального costMin |

- [ ] Нові `*.service.ts` → парний `*.spec.ts` з мінімальними кейсами вище
- [ ] Нові `@Controller` → парний `*.contract.spec.ts`
- [ ] Нові query-param фільтри (dateFrom, dateTo, branchId, q...) у існуючому QueryDto (Bugs #338, #339) — `T1.5-010`
- [ ] Boundary-кейси для діапазонних правил (COST_TIER, sliding-scale, age-brackets, tax-brackets) — `T1.5-011`
- [ ] Cross-tenant FK contract test для optional FK у payload — `T1.5-012`
- [ ] Тест шукає значення підрядком (`includes`) у рядку з ВИПАДКОВИМ вмістом (шифротекст, base64, uuid, hash): короткий зразок (`'r1'`, `'ab'`) збігається випадково → падіння раз на десятки прогонів. Шукати лише поза випадковими рядками або брати зразок із символом поза алфавітом (Bug #803). Grep: `grep -rnE "includes\((secret|token|value)\)" apps/api/src --include=*.spec.ts`

- [ ] Integration-спек на dev-БД видаляє/змінює рядки за ПРИРОДНИМ ключем, а не за власним `id` (Bug #782; детектор і доказ — одразу під пунктом, у журналі їх нема) — `T1.5-013`

  ```bash
  grep -rnE 'DELETE FROM|deleteMany\(' apps/api/src --include=*.integration.spec.ts | grep -vE 'WHERE id ?= ?(ANY\()?\$1'
  ```

  Доказ — пробний рядок із власним маркером: вставити, прогнати спек, перевірити, що він на місці. Фікс — транзакція з відкатом (`$transaction` + `throw RollbackSignal`), raw-запити через той самий `tx`. Окремо дивитись на «має кинути»-тести з руйнівною дією під `rejects` (`deleteMany({ where: { deletedAt: null } })`): якщо guard регресує, тест не просто впаде, а виконає видалення.

- [ ] Новий `*.integration.spec.ts` не названий у явному списку CI-job-а або бере дані з рядків, яких seed не створює → у CI не виконується (Bug #806) — `T1.5-014`

- [ ] Property-тест грошової функції: генератори мають включати нуль (кількість 0) і копійчані ціни, а властивість — перевіряти знак кожного рядка, не лише суми (Bug #810). Доказ сили — мутація: зламати гілку вирівнювання й побачити контрприклад.

---
