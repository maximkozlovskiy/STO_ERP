# sto-tester — журнал підходів, 2026-08

> Не читати цілком — шукати за ключовим словом.

### 2026-08-30 — Cross-field guard + новий single-pass aggregator без regression-test (Bug #597) — backend / test-coverage / regression-guard

**Сигнал:** service має `throw new BadRequestException` для крос-полю (`from>to`, `windowDays>100`) АБО новий single-pass aggregator (`for-of`+`totals.byX`). Парний spec без `it(...)` для guards/aggregators (split-fix).

```bash
grep -rn "throw new BadRequestException" apps/api/src/modules --include="*.service.ts" -B1 | grep -B1 "if (.*>.*\|if (.*<.*"
grep -rn "'Вікно графіка не може перевищувати'" apps/api/src --include="*.spec.ts"   # 0 = gap (грепни конкретний guard-меседж у специ)
grep -rn "totals\.byX\|totals\.byDate\|totals\.by" apps/api/src --include="*.spec.ts"   # тільки totals.total → gap
```

**Фікс:** cross-field 3 кейси (invalid→`rejects`; `expect(prisma.X.find).not.toHaveBeenCalled()`; boundary→resolves `>` vs `>=`). Aggregator 1-2 (2+ contributors→sum; empty bucket не в output; Σ buckets==grand total).
**Severity:** MEDIUM. Pre-commit: review/optimize commit з `.service.ts` вимагає діф у `.spec.ts`.
**Де ще:** сервіс з recent `simplify:`/`perf(optimize):`/`fix(review):` — `git show <commit> --stat | grep -E "service.ts|spec.ts"`.

### 2026-08-30 / 2026-09-06 — URL deep-link writer без парного reader (Bug #596) — frontend / navigation / broken-feature

**Сигнал:** кнопка «покажи X у Y» (`ExternalLink`, `text-primary`), клік перекидає у Y — але Y відкривається у голому стані. Grep `?<param>=` = РІВНО 1 match (писач без читача). Next.js ігнорує unknown query params.

```bash
grep -rnE "router\.(push|replace)\(\`?[/'\"][a-z-/]+[^)]*\?[a-z]+=" apps/web/src --include="*.tsx"
grep -c "searchParams.get('$param')" apps/web/src/app/\(app\)/$target/page.tsx || echo "MISSING READER"
```

**Фікс:** (A) reader на mount читає param, виконує дію, одразу очищає (ідемпотентно, mount-only без deps):

```typescript
useEffect(() => {
  const openId = searchParams.get('open');
  if (openId && UUID_RE.test(openId)) {
    setEditingPOId(openId);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('open');
    router.replace(params.toString() ? `?${params.toString()}` : '?', { scroll: false });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []); // mount-only — refresh не reopens
```

(B) прибрати param у writer якщо feature не готова. Regression: Playwright `page.goto('/target?param=<uuid>')`→`expect(modal-or-row).toBeVisible()`.
**Severity:** LOW (broken UX); MEDIUM якщо tooltip/label обіцяє дію.
**Де ще:** cross-linking pairs: counterparties↔work-orders, vehicles↔work-orders, invoices↔counterparties, purchase-orders↔supplier-payments, warehouses↔stock-documents.

### 2026-08-30 — Spec-vs-impl timezone-arithmetic parity (Bug #592) — api / test / dst-aware

**Сигнал:** baseline API vitest падає `expected 'YMD_A' to be 'YMD_B'` (1 день). Spec `new Date()+setUTCDate()` (UTC), impl `kyivToday()/addDaysKyiv()`. Падає у ~3h UTC-північ↔Kyiv-північ; днем passes (deterministic bug у spec).

```bash
grep -rn "setUTCDate\|toISOString().slice(0, 10)" apps/api/src --include="*.spec.ts"
```

**Фікс:** `new Date()+setUTCDate(+N)`→`addDaysKyiv(kyivToday(),N)` (import `../../common/utils/kyiv-date`).
**Severity:** HIGH (release-blocker у 3h/day вікні).
**Де ще:** spec з paymentDate/dueDate/expiryDate/documentDate/@db.Date; auto-fill дати receive() PO, create() Invoice.

### 2026-08-30 — QueryClientProvider absent після React Query hook migration (Bug #593, #460) — web / test / rq-migration

**Сигнал:** baseline web vitest `Error: No QueryClient set`. Stack на новий hook (`use*Mutation`) у компоненті що раніше юзав raw apiFetch. Transitive: parent modal падає бо рендерить migrated child.

```bash
for hook in $(grep -rlE "^export function use(Create|Update|Delete|Confirm|Cancel)" apps/web/src/hooks/api --include="*.ts"); do
  grep -rln "$(basename $hook .ts)" apps/web/src/components --include="*.tsx" | grep -v test
done
for comp in $(git diff HEAD~5 HEAD --name-only apps/web/src/components/ui/*.tsx); do test="apps/web/src/components/ui/__tests__/$(basename $comp .tsx).test.tsx"; [ -f "$test" ] && grep -q "QueryClientProvider\|renderWithQueryClient" "$test" || echo "MISSING QCP: $test"; done
```

**Фікс:**

```typescript
function renderWithQueryClient(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
```

Довгостроково: shared `test-utils.tsx renderWithProviders` (QueryClient+Router+AuthProvider).
**Severity:** HIGH (release-blocker baseline; критично для regression-guard тестів #460).
**Де ще:** кожен `*.test.tsx` для `components/ui/*.tsx` з useMutation/useQuery; transitive parent modals.

### 2026-08-30 — Partial hook migration: один branch мігрований, інший raw apiFetch (Bug #594) — web / cache / rq-migration-completeness

**Сигнал:** компонент 2+ branches: A `if(isEdit)updateMut.mutateAsync` (auto-invalidate), B `else await apiFetch(POST)` (raw, БЕЗ invalidate) → одна гілка stale (до staleTime=30s). User: «оновлення одразу, створення з затримкою».

```bash
grep -rn "^export function use\(Create\|Update\|Delete\|Confirm\|Cancel\)" apps/web/src/hooks/api --include="*.ts" -l | while read hookfile; do
  hookname=$(basename $hookfile .ts | sed 's/^use//')
  endpoint=$(grep -A 3 "^export function use\(Create\|Update\)" $hookfile | grep "apiFetch" | grep -oE "'/[^']*'" | head -1)
  [ -z "$endpoint" ] && continue
  grep -rln "use\(Create\|Update\|Delete\)$hookname" apps/web/src/components apps/web/src/app --include="*.tsx" | grep -v test | while read c; do
    grep -q "apiFetch($endpoint" "$c" && echo "PARTIAL MIGRATION: $c BOTH hook AND raw apiFetch"
  done
done
```

**Фікс:** імпортувати парний hook, `const createMut=useCreateSupplierPayment()`, замінити raw на `await createMut.mutateAsync(payload)`, deps. Regression: mock apiFetch + click «Створити»→assert URL+`invalidateQueries`.
**Severity:** HIGH (silent UX gap, самовиправляється 30s).
**Де ще:** modal з `if(isEdit)updateMut else apiFetch(POST)`; нещодавно refactor-нуті `feat(rq): migrate`.

### 2026-08-30 — Regex-shape validation без semantic parseability (Bug #595, #616) — api / dto / validator

**Сигнал:** DTO приймає `@Matches(/^\d{4}-\d{2}-\d{2}$/)` як ЄДИНУ валідацію дати. `?from=2026-99-99`→200 з empty/silent-wrong (regex перевіряє SHAPE не SEMANTIC). Downstream `new Date('2026-99-99')`→Invalid Date→NaN.

```bash
grep -rnE "@Matches\(.*\\\\d\{4\}.*\\\\d\{2\}.*\\\\d\{2\}" apps/api/src/modules --include="*.dto.ts"
# curl "?from=2026-99-99" → 200 з empty = bug
```

**Фікс:** `@IsDateString({strict:true})` РАЗОМ з `@Matches(YMD_RE)`:

```typescript
@IsDateString({ strict: true }, { message: 'from має бути валідною датою' })
@Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from має бути у форматі YYYY-MM-DD' })
from!: string;
```

**sibling-drift #616 (регресія #595):** sprint додає sibling DTO — копіює `@Matches(YMD_RE)` БЕЗ парного `@IsDateString({strict:true})` (читає декоратори наявного поля, не doc). Guard:

```bash
for f in $(grep -rl "IsDateString.*strict.*true" apps/api/src/modules --include="*.dto.ts"); do
  awk '/@Matches\(YMD_RE/{ if (!has_ds) print FILENAME ":" NR ": lone @Matches"; has_ds=0 } /@IsDateString.*strict/{ has_ds=1 } /^[[:space:]]*[a-z].*:/{ has_ds=0 }' "$f"
done
```

**Severity:** MEDIUM (silent empty/wrong).
**Де ще:** DTO з YMD-date param (reports/calendar/schedule/dashboard); phone/IBAN/EDRPOU без checksum.

### 2026-08-30 — E2E: seeded entity invisible через дефолтний date-фільтр списку (Bug #572) — e2e / seed-brittle / list-filters

**Сигнал:** seed через API (`beforeAll`), список не знаходить row; screenshot «Нарядів не знайдено» з date-input «today». `documentDate @default(now()) @db.Date`=UTC (Docker), UI дефолт `dateFrom=kyivToday()`. У 00:00-03:00 Kyiv UTC-дата на добу менша.

```bash
grep -rn "@default(now()).*@db.Date\|dateFrom.*kyivToday" apps/ --include="*.tsx" --include="*.ts"
```

**Фікс (у ТЕСТІ):** перед пошуком очистити date-input (`fill('')→press('Escape')`); `getByRole('textbox',{name:/Пошук/i}).fill(number)`.
**Severity:** HIGH (стабільно червоний 3h/добу + завжди CI UTC).
**Де ще:** e2e з beforeAll API-seed + UI (`grep -rn "beforeAll.*await\|await.*seed" apps/web/e2e`); списки з `dateFrom=kyivToday()`; дефолтні filter (branchId, warehouseId, status).

### 2026-08-30 — E2E: DST-aware Kyiv timezone у test time-arithmetic (Bug #573) — e2e / dst / timezone

**Сигнал:** тест створює time-ресурс через API+перевіряє UI; у 00:00-03:00 Kyiv падає. Тест `new Date().toISOString().split('T')[0]`=UTC (завжди попри `timezoneId`), frontend `Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Kyiv'})`.

```bash
grep -rn "toISOString.*split.*T.*\[0\]\|new Date().*toISOString" apps/web/e2e --include="*.spec.ts"
```

**Фікс (у ТЕСТІ):** Kyiv-дата `Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Kyiv'})`; Kyiv wall-clock→UTC DST-safe:

```ts
function kyivWallToUtcIso(kyivDate, kyivHour, kyivMinute = 0) {
  const guess = new Date(
    `${kyivDate}T${String(kyivHour).padStart(2, '0')}:${String(kyivMinute).padStart(2, '0')}:00Z`,
  );
  const kyivHourOfGuess = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Kyiv',
      hour: 'numeric',
      hour12: false,
    }).format(guess),
    10,
  );
  return new Date(guess.getTime() + (kyivHour - kyivHourOfGuess) * 3_600_000).toISOString();
}
```

Anti-pattern: hardcoded `+3`/`+2`; `getTimezoneOffset()`. Frontend unit — Intl не респектує `vi.setSystemTime()` TZ, юзати `vi.stubEnv('TZ','Europe/Kyiv')`.
**Severity:** HIGH (CI-only, не reproducible без `TZ=UTC`).
