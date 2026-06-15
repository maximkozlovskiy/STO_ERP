---
name: sto-e2e
description: >
  E2E тестування STO ERP через Playwright. Запускає suite, знаходить баги в коді
  (не адаптується під них), виправляє код або тест залежно від природи проблеми.
  Ключове правило: тест падає = щось зламано → знайти ЩО і виправити, а не
  обійти. Використовує MCP для інспекції живого DOM. Запускай: /sto-e2e після
  змін у frontend або для перевірки регресій.
model: claude-sonnet-4-6
bypassPermissions: true
---

# sto-e2e — Playwright E2E для STO ERP

## Головне правило

> **Тест — це специфікація поведінки, не snapshot UI.**
>
> Тест падає → або **баг у коді** (поведінка зламана → виправити код),
> або **тест застарів** (поведінка навмисно змінилась → оновити тест).
>
> **Заборонено:**
>
> - `if (!(await el.isVisible())) return;` — ховає проблему замість фіксу
> - `expect(x || true).toBe(true)` — тест завжди зелений, нічого не перевіряє
> - збільшити timeout щоб елемент нарешті з'явився — затримка є симптомом, а не нормою
> - додати елемент до `IGNORE_PATTERNS` якщо він вказує на реальну помилку
>
> Якщо елемент не відображається — розібратись ЧОМУ, а не обійти.

---

## Алгоритм (Auto — без питань)

```
1. Перевірити сервери
2. Запустити тести
3. Для кожного падіння — визначити природу: баг у коді чи тест застарів
4. Виправити відповідно (код або тест)
5. Перезапустити — переконатись що зелено
6. Занотувати баги у BUG_REPORT.md, коміт
```

---

## Крок 1 — Перевірка серверів

```bash
docker ps --format "{{.Names}}\t{{.Status}}" | grep -E "postgres|redis|minio"
curl -s http://localhost:3000/api/health | head -c 80 && echo "" || echo "API:DOWN"
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001 | grep -qE "^(200|30)" && echo "WEB:UP" || echo "WEB:DOWN"
```

Якщо API:DOWN:

```bash
pnpm --filter @sto/api dev > /tmp/sto-api.log 2>&1 &
until curl -s http://localhost:3000/api/health > /dev/null 2>&1; do sleep 3; done && echo "API ready"
```

> **STALE API**: `404` на існуючому роуті = старий процес. `curl :3000/api/<route>` → `401` = OK, `404` = перезапустити.

---

## Крок 2 — Запуск тестів

```bash
cd apps/web
npx playwright test --reporter=list 2>&1 | tee /tmp/pw-results.txt
tail -20 /tmp/pw-results.txt
```

Окремий файл/grep:

```bash
npx playwright test e2e/work-orders.spec.ts --reporter=list
npx playwright test --grep "назва тесту"
```

Мапи: `smoke`, `auth`/`auth-flow`, `work-orders`/`wo`, `crm`, `inventory`, `settings`, `console`/`errors`, `api-errors`.

---

## Крок 3 — Діагностика кожного падіння

### 3.1 Визначити природу проблеми

Для кожного failed тесту задати собі питання:

```
Чи ПОВИННА ця поведінка працювати?
  ТАК → баг у коді → виправити код
  НІ (поведінку навмисно прибрали/змінили) → тест застарів → оновити тест
```

**Інструменти діагностики:**

```bash
# 1. Скріншот падіння — перший крок
ls apps/web/test-results/*/test-failed-*.png

# 2. DOM у живому браузері через MCP
mcp__playwright__browser_navigate → http://localhost:3001/<route>
mcp__playwright__browser_snapshot → переглянути реальну структуру
mcp__playwright__browser_evaluate → () => document.querySelectorAll('button')[...].textContent

# 3. Консольні помилки на сторінці
mcp__playwright__browser_console_messages

# 4. Headed run — дивитись що відбувається
cd apps/web && npx playwright test e2e/<file>.spec.ts --headed --slowMo=800

# 5. Trace — детальний replay
cd apps/web && npx playwright show-trace test-results/*/trace.zip
```

### 3.2 Таблиця діагностики

| Симптом                       | Питання                                    | Відповідь → Дія                                                              |
| ----------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| Елемент не знайдено (timeout) | Він повинен бути на сторінці?              | ТАК → баг (компонент не рендериться, API помилка, auth проблема) → фікс коду |
| Елемент не знайдено (timeout) | Він повинен бути на сторінці?              | НІ (вилучили фічу) → оновити тест                                            |
| Redirect на `/login`          | Auth має працювати?                        | ТАК → баг auth guard або token expiry → фікс                                 |
| `console.error` на сторінці   | Помилка реальна?                           | ТАК → баг у коді → фікс; НІ (відомий browser quirk) → IGNORE_PATTERNS        |
| `429 Too Many Requests`       | Rate limit коректний для цього endpoint?   | auth/refresh → `@SkipThrottle()`; інші → можливо OK                          |
| FSM кнопка відсутня           | Наряд у фінальному статусі?                | ТАК → graceful; НІ → баг                                                     |
| Форма не закривається         | Баг UI чи тест не знає реального локатора? | Перевірити через MCP → фікс відповідно                                       |

---

## Крок 4 — Виправлення: баг у коді

Якщо тест виявив реальну проблему → **виправити код**, не тест.

```
1. Зафіксувати у BUG_REPORT.md (severity + файл + опис)
2. Знайти root cause (grep, Read файлу, MCP snapshot)
3. Виправити код (frontend або backend)
4. Перезапустити тест — має стати зеленим
5. tsc --noEmit — 0 errors
6. git add + git commit "fix(<scope>): <опис>"
```

**Приклади реальних багів які E2E повинен знаходити:**

- Кнопка FSM не з'являється → перевірити логіку `isEditingPast`, FSM transition map, `@SkipThrottle`
- Сторінка редіректить на `/login` → перевірити auth guard, token refresh, `@SkipThrottle` на `/auth/refresh`
- `console.error` з `401` → перевірити чи правильно встановлюється Bearer token
- `console.error` з `500` → перевірити backend endpoint, Prisma query, null safety
- Таблиця порожня але дані є в БД → перевірити API query params, orgId filter, soft delete
- Форма не відправляє → перевірити валідацію DTO (`@Transform(emptyToUndefined)`), required поля

---

## Крок 5 — Виправлення: тест застарів

Тест оновлюється **тільки** якщо поведінка навмисно змінилась:

```
✅ Дозволено оновити тест:
- Текст кнопки змінився ("Зберегти" → "Додати") — це рефакторинг UI
- Компонент отримав data-testid — локатор можна покращити
- Функцію прибрали з продукту — тест більше не релевантний
- URL роуту змінився

❌ Заборонено оновити тест:
- Замінити expect на graceful if/return → це приховує баг
- Збільшити timeout до "поки не знайдеться" → це маскує повільний рендер
- Додати || true до expect → це робить тест беззмістовним
- Замінити строгу перевірку на "або те, або інше, або нічого"
```

**Якщо не знаєш — тест залишити як є і зафіксувати у BUG_REPORT.md.**

---

## Крок 6 — Написання нових тестів

### Принципи

Новий тест повинен **специфікувати поведінку**, а не **документувати поточний стан**:

```typescript
// ❌ ПОГАНО — описує що є, а не що повинно бути
test('кнопка іноді присутня', async ({ page }) => {
  const btn = page.locator('button').first();
  if (await btn.isVisible()) expect(btn).toBeVisible();
});

// ✅ ДОБРЕ — специфікує очікувану поведінку
test('кнопка "Новий наряд" завжди присутня для ADMIN', async ({ page }) => {
  await page.goto('/work-orders');
  await expect(page).toHaveURL(/\/work-orders/, { timeout: 15_000 });
  await expect(page.locator('button:has-text("Новий наряд")')).toBeVisible({ timeout: 20_000 });
});
```

### Через MCP (живий DOM → тест)

```
1. mcp__playwright__browser_navigate → сторінка
2. mcp__playwright__browser_snapshot → знайти точні selector/text/role
3. mcp__playwright__browser_evaluate → перевірити edge cases
4. Написати spec на основі реальної DOM-структури
```

### Шаблон spec

```typescript
import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

test.describe('<Фіча>', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/<route>');
    // Чекати конкретний ready-signal, а не просто domcontentloaded
    await expect(page).toHaveURL(/\/<route>/, { timeout: 15_000 });
    await page
      .locator('<стабільний-елемент-що-сигналізує-готовність>')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 });
  });

  test('<конкретна поведінка>', async ({ page }) => {
    // Дія
    await page.locator('button:has-text("Назва")').click();
    // Очікуваний результат — строгий
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 8_000 });
  });
});
```

### Локатори по пріоритету

```
1. [data-testid="..."]                    — найстабільніший, додати до компонента якщо потрібно
2. getByRole('button', { name: '...' })   — semantic, не залежить від CSS
3. button:has-text("...")                 — текст може мінятись
4. input[placeholder*="..."]             — для полів вводу
5. .className                             — найкрихкіший, уникати
```

---

## Крок 7 — Звіт і коміт

```bash
# Баги у коді → BUG_REPORT.md
# Тест застарів → оновлений spec файл

git add apps/web/e2e/ apps/api/src/ apps/web/src/ BUG_REPORT.md
git commit -m "fix(e2e): <опис виправленого бага>"
# або
git commit -m "test(e2e): update locators after UI refactor"
```

Оновити `MemoryManual.md` якщо знайдено новий gotcha.

---

## Структура E2E suite

```
apps/web/e2e/
├── setup-auth.ts           ← globalSetup: JWT + storageState (sessionStorage patch)
├── fixtures.ts             ← authPage fixture + loginViaAPI helper
├── smoke.spec.ts           ← публічні сторінки, статичні ресурси, security headers
├── auth-flow.spec.ts       ← login form, invalid creds, guard на 9 роутів, logout
├── work-orders.spec.ts     ← список, фільтри, модалка, картка, FSM
├── crm.spec.ts             ← список, пошук, тип-фільтр, картка
├── settings.spec.ts        ← вкладки, dark/light theme
├── inventory.spec.ts       ← auth guard, mock API states
├── console-errors.spec.ts  ← 0 console.error на всіх сторінках (serial mode)
└── api-errors.spec.ts      ← resilience при 500 від API
```

**Конфіг:** `apps/web/playwright.config.ts`

- `workers: 4` локально — запобігає rate limit burst при паралельному auth
- `retries: 1` локально — flaky через dev rate limit, але не баги
- `locale: uk-UA`, `timezoneId: Europe/Kyiv`
- `webServer: reuseExistingServer: true` — не перезапускає якщо вже є

---

## Gotchas

| Проблема                                                          | Причина                                                                                          | Правильне рішення                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redirect на `/login` при тестах                                   | Token протух або `/auth/refresh` throttled                                                       | `@SkipThrottle()` на refresh; не `if (auth) skip`                                                                                                                                                                                                                                |
| `networkidle` не настає                                           | SSE (dashboard) або TanStack polling                                                             | Чекати конкретний UI-елемент, не `networkidle`                                                                                                                                                                                                                                   |
| Element not found після `domcontentloaded`                        | React async fetch не завершився                                                                  | `waitFor({ state: 'visible' })` на ready-signal                                                                                                                                                                                                                                  |
| `sessionStorage` не в storageState                                | Playwright 1.40+ потрібен патч                                                                   | setup-auth.ts явно записує sessionStorage в JSON                                                                                                                                                                                                                                 |
| `serial` mode у console-errors                                    | Cold Next.js dev compile race                                                                    | Не змінювати на `parallel`                                                                                                                                                                                                                                                       |
| 429 на `/auth/refresh`                                            | Dev throttler                                                                                    | `@SkipThrottle()` — refresh захищений cookie                                                                                                                                                                                                                                     |
| Тест "проходить" але поведінка зламана                            | `\|\| true` або `if return` в тесті                                                              | Видалити обхідний шлях, знайти реальний баг                                                                                                                                                                                                                                      |
| `tsqd-parent-container subtree intercepts pointer events`         | TanStack Query Devtools FAB (bottom-left) перекриває кнопку у viewport                           | Прибрати DevTools у E2E через `localStorage.sto_e2e_disable_devtools='1'` (setup-auth додає у storageState, QueryProvider читає)                                                                                                                                                 |
| Кнопка `Новий X`/`Нове X` не знайдена                             | Add-button у списках перейменовано на одне слово (3785721/c3cd333)                               | Використати `getByRole('button', { name: /^X$/ })` з exact match щоб не зловити заголовок `Xs` (множина)                                                                                                                                                                         |
| Row-action button `Деталі` не знайдено                            | Hover-only icon Pencil з `title="Відкрити деталі"` (a5cf804)                                     | `row.hover()` + `row.locator('button[title="Відкрити деталі"]').click()`                                                                                                                                                                                                         |
| Модалка створення товару не закривається після `Зберегти`         | `openEditGood(newGood)` після save → reopen в edit mode                                          | Чекати title `Редагування товару`, потім Escape з dirty-guard handling                                                                                                                                                                                                           |
| Modal title тесту не з'являється після click на Tab               | Tab content ще не змонтований коли тест клікає `Додати`                                          | Чекати `h2:has-text(tabName)` (section header) перед `Додати`                                                                                                                                                                                                                    |
| Тест skipна́в бо немає WO/Doc/Counterparty потрібного статусу у БД | seed.ts не містить кожен FSM-статус; conditional `test.skip(list.length===0)` ховає coverage gap | Self-seeding: `beforeAll` клонує доступний DRAFT через `POST /:id/clone`, транзитить до потрібного статусу через `POST /:id/transition`; `afterAll` cleanup тільки якщо FSM дозволяє delete-шлях (`WO_DELETABLE_STATUSES`). 0 leak, deterministic coverage. (Bug #486, 231b0be2) |
| 429 ThrottlerException у `beforeAll`/тестах при login             | 4 workers × per-test `/api/auth/login` → throttle burst                                          | Читати JWT з `e2e/.auth/admin.json` (globalSetup його туди вже кладе у `origins[].sessionStorage[sto_access_token]`) замість нового login                                                                                                                                        |
