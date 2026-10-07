# sto-tester — Крок 5: розширені тести (лише режим FULL)

> Частина скіла `sto-tester`; у режимі AUTO не читати. Алгоритм — у `../SKILL.md`.

## Крок 5 — Розширені тести (FULL режим)

> Повні шаблони коду тестів — окремі файли, читати той, що потрібен: `templates-api.md`
> (contract, property-based, service-спеки: §4.3, §4.4, §4.8, §4.9, §S) і `templates-web-e2e.md`
> (E2E, component, хуки: §4.5–§4.7).

### 5.1 — Property-based (fast-check)

```bash
grep "fast-check" apps/api/package.json || pnpm --filter @sto/api add -D fast-check
pnpm --filter @sto/api test --run --reporter=verbose 2>&1 | grep -E "invariant|property|PASS|FAIL"
find apps/api/src -name "*.invariants.spec.ts" | sort
```

| Модуль            | Інваріанти                                                                    |
| ----------------- | ----------------------------------------------------------------------------- |
| `work-orders.fsm` | всі пари (from, to) → blocked; ARCHIVED/CANCELLED = порожні                   |
| `inventory`       | quantity≥0, reserved≥0, available≥0 після валідних рухів                      |
| `settlements`     | CHARGE ↑balance; PAYMENT/REFUND/CREDIT_NOTE ↓balance                          |
| `pricing`         | PERCENT = `cost*(1+pct/100)`; округлення кратне roundTo; `Math.max(0,result)` |

### 5.2 — E2E (Playwright)

> **Повний E2E workflow → `/sto-e2e`** (окремий скіл з детальними інструкціями, кодогенерацією через MCP, аналізом падінь).

Мінімальний запуск для автоматичного tester-циклу:

```bash
# Перевірити сервери
docker ps --format "{{.Names}}\t{{.Status}}" | grep -E "postgres|redis|minio"
curl -s http://localhost:3000/api/health | head -c 80 && echo "" || echo "API:DOWN"
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001 | grep -qE "^(200|30)" && echo "WEB:UP" || echo "WEB:DOWN"

# Запуск (82 тести, 8 spec файлів)
cd apps/web && npx playwright test --reporter=list 2>&1 | tee /tmp/pw-results.txt | tail -40
```

**⚠️ STALE API** — `404` при наявному маршруті = stale server. `curl localhost:3000/api/<route>` → `401` = OK, `404` = перезапустити API.

**Структура suite:** `smoke` · `auth-flow` · `work-orders` · `crm` · `settings` · `inventory` · `console-errors` (serial) · `api-errors`

**Auth state** (`e2e/.auth/admin.json`) оновлюється автоматично через `globalSetup`. Якщо відсутній — видалити і перезапустити.

**⚠️ ПЕРЕДУМОВА auth-gated suite: web-сервер МУСИТЬ мати `NEXT_PUBLIC_E2E=1`.** E2E auth-hatch у `context.tsx` (`E2E_HATCH_ENABLED = process.env.NEXT_PUBLIC_E2E === '1'`) вбудовується Next.js-ом на КОМПІЛЯЦІЇ — якщо сервер стартував без прапора (звичайний `pnpm --filter @sto/web dev`), hatch tree-shake-иться геть → stored `sto_e2e_access_token` НЕ гідрується → УСІ `test.use({storageState:'admin.json'})`-специ падають (сторінки бачать unauth → spinner/redirect → timeout), а fresh-login специ (auth-flow) і route-mock специ (api-errors) проходять. `playwright.config.ts webServer` ставить прапор ЛИШЕ коли САМ стартує сервер; при `reuseExistingServer:true` уже-запущений сервер БЕЗ прапора мовчки переможе. **Симптом-сигнатура:** широка смуга падінь усіх storageState-специ з ~15-20s timeout на першому асерті, тоді як сторінка рендериться коректно при РУЧНОМУ логіні (MCP) — це НЕ баг гілки, а сервер без прапора. Fix: kill 3001 → `NEXT_PUBLIC_E2E=1 NEXT_PUBLIC_API_URL=http://localhost:3000 pnpm --filter @sto/web dev` → перезапустити suite. Швидка перевірка гіпотези: перезапустити ОДИН storageState-спец (bookings) — якщо зазеленів за ~1s замість 15s timeout → підтверджено.

**Падіння → `/sto-e2e debug <spec>`** для повного аналізу.

**⚠️ Слабкий асерт (Bug #625)** — «доказовий» асерт має бути scoped до цільового піддерева, не page. Grep-детектор фіктивних guard-ів:

```bash
# Широкий page-level селектор для «з'явився результат» при наявних службових decoy-контролах
grep -rnE "page\.locator\('button\[aria-expanded\]'\)\.first|page\.getByRole\('(button|table|tab|listitem)'\)\.first|page\.locator\('table'\)\.first" apps/web/e2e
# Для кожного match: чи є на сторінці ІНШИЙ елемент того ж роду (хедер-тоггл з aria-expanded,
# службова кнопка/таблиця)? Якщо так → scope до контейнера результату (table.locator(...)) +
# позитивні якорі стану (thead th=='Група', count>1, очікувані лейбли) + негативний якір анти-стану.
# Sanity: тимчасово «зламати» очікуваний стан — тест МАЄ почервоніти; якщо лишився зелений → асерт слабкий.
```

### 5.3 — Component-тести (Testing Library)

```bash
grep "@testing-library" apps/web/package.json || \
  pnpm --filter @sto/web add -D @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
find apps/web/src -name "*.test.tsx" | sort
pnpm --filter @sto/web exec vitest run --reporter=verbose 2>&1 | tail -30
```

### 5.4 — User-path verification (ОБОВ'ЯЗКОВО для UI-фіч)

> **Клас багів «функція недосяжна через UX»:** бекенд коректний, API повертає правильне,
> АЛЕ користувач не може досягти результату через інтерфейс (напр. поле кладеться не в ту
> зону; єдиний спосіб — ненадійний drag; немає сигналу «що робити»). API-верифікація
> (`Σ==grandTotal`, 200-статус) ЦЕ НЕ ЛОВИТЬ. Реально траплялось: «не групує» × 3 повернення.

Для **будь-якої UI-фічі** (нова сторінка / компонент / interaction) — окрім API-перевірки
пройти **шлях реального користувача** через Playwright MCP і зробити скріншот РЕЗУЛЬТАТУ:

- [ ] Пройти сценарій кліками (не прямим `fetch` у `page.evaluate`) — так, як це робить юзер.
- [ ] `browser_snapshot` / скріншот кінцевого стану → **очима перевірити** що видно ОЧІКУВАНЕ,
      а не порожній/плоский/помилковий результат.
- [ ] Якщо результат недосяжний або незрозумілий без інструкції → це **UX-баг**, фіксувати як
      баг коду (додати сигнал/підказку/явний елемент керування), не лишати на «поясню текстом».
- [ ] Головний happy-path закріпити E2E-тестом що йде **через UI-контроли** (клік кнопки),
      а не лише через API-конфіг — інакше регресія UX пройде мовчки.

Мінімум (якщо MCP недоступний) — E2E що проходить фічу через видимі контроли + асерт що
кінцевий стан містить очікуваний елемент (група/сума/рядок), не лише статус 200.

---
