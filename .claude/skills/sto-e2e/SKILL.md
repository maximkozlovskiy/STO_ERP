---
name: sto-e2e
description: >
  E2E тестування STO ERP через Playwright. Запускає повний або вибірковий suite
  для Next.js web-частини (apps/web). Підтримує: запуск усіх тестів, фільтрацію
  по файлу/тегу/grep, headed/debug режим, кодогенерацію нових тестів через MCP,
  аналіз та виправлення падаючих тестів, перевірку серверів перед запуском.
  Запускай: /sto-e2e після змін у frontend, або для написання нових E2E тестів.
model: claude-sonnet-4-6
bypassPermissions: true
---

# sto-e2e — Playwright E2E для STO ERP

## Коли використовувати

| Ситуація                                     | Команда                         |
| -------------------------------------------- | ------------------------------- |
| Перевірити що нічого не зламалось після змін | `/sto-e2e`                      |
| Запустити тільки один spec-файл              | `/sto-e2e work-orders`          |
| Запустити з відкритим браузером              | `/sto-e2e headed`               |
| Написати новий тест через браузер            | `/sto-e2e codegen /work-orders` |
| Зрозуміти чому тест падає                    | `/sto-e2e debug work-orders`    |
| Інтерактивний UI для відбору тестів          | `/sto-e2e ui`                   |

---

## Алгоритм (Auto — без питань)

```
1. Крок 1 — перевірити сервери (docker + API + Web)
2. Крок 2 — auth setup (e2e/.auth/admin.json)
3. Крок 3 — запустити тести
4. Крок 4 — аналіз падінь
5. Крок 5 — виправити падаючі тести (якщо причина в коді, не в тесті)
6. Крок 6 — звіт + git commit якщо були зміни
```

---

## Крок 1 — Перевірка серверів

```bash
# Docker інфраструктура
docker ps --format "{{.Names}}\t{{.Status}}" | grep -E "postgres|redis|minio"

# API (порт 3000)
curl -s http://localhost:3000/api/health | head -c 100 && echo "" || echo "API:DOWN"

# Web (порт 3001)
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001 | grep -qE "^(200|30)" && echo "WEB:UP" || echo "WEB:DOWN"
```

**Якщо API:DOWN** — запустити і чекати:

```bash
pnpm --filter @sto/api dev > /tmp/sto-api.log 2>&1 &
until curl -s http://localhost:3000/api/health > /dev/null 2>&1; do sleep 3; done
echo "API ready"
```

**Якщо WEB:DOWN** — Next.js запустить `webServer` автоматично через `playwright.config.ts`
(налаштований `reuseExistingServer: true`). Якщо потрібен ручний запуск:

```bash
pnpm --filter @sto/web dev > /tmp/sto-web.log 2>&1 &
until curl -s http://localhost:3001 > /dev/null 2>&1; do sleep 3; done
echo "WEB ready"
```

> **⚠️ STALE API** — `404 "Cannot GET /api/X"` при наявному маршруті у коді = старий процес
> не бачить нових контролерів. Діагностика: `curl localhost:3000/api/<route>` → `404` = stale,
> `401` = OK (auth). Фікс: `kill $(lsof -t -i:3000)` → перезапустити.

---

## Крок 2 — Auth Setup

Auth state зберігається в `apps/web/e2e/.auth/admin.json` (у `.gitignore`).
Якщо файл відсутній або застарілий — `globalSetup` з `playwright.config.ts` відновить його.

```bash
# Перевірка наявності auth state
ls apps/web/e2e/.auth/admin.json 2>/dev/null && echo "auth:OK" || echo "auth:MISSING (буде створений globalSetup)"

# Примусове оновлення auth state
cd apps/web && node -e "
  const setup = require('./e2e/setup-auth.ts');
  // Виконується автоматично через globalSetup у playwright.config.ts
  console.log('Auth state буде оновлений при наступному запуску playwright');
"
```

Auth state оновлюється автоматично при кожному `playwright test` через `globalSetup`.
Credentials: `admin@sto.local` / `admin123` (seed у `packages/database/prisma/seed.ts`).

---

## Крок 3 — Запуск тестів

### Повний suite

```bash
cd apps/web
npx playwright test --reporter=list 2>&1 | tee /tmp/pw-results.txt
```

### За spec-файлом (аргумент до /sto-e2e)

```bash
# /sto-e2e work-orders → запускає e2e/work-orders.spec.ts
cd apps/web
npx playwright test e2e/work-orders.spec.ts --reporter=list
```

Мапа аргументів → файлів:
| Аргумент | Файл |
|---|---|
| `smoke` | `e2e/smoke.spec.ts` |
| `auth` / `auth-flow` | `e2e/auth-flow.spec.ts` |
| `work-orders` / `wo` | `e2e/work-orders.spec.ts` |
| `crm` | `e2e/crm.spec.ts` |
| `inventory` | `e2e/inventory.spec.ts` |
| `settings` | `e2e/settings.spec.ts` |
| `console` / `errors` | `e2e/console-errors.spec.ts` |
| `api-errors` | `e2e/api-errors.spec.ts` |

### За grep (назвою тесту)

```bash
cd apps/web
npx playwright test --grep "Login flow" --reporter=list
```

### Headed (з відкритим браузером)

```bash
cd apps/web
npx playwright test --headed --slowMo=500 e2e/work-orders.spec.ts
```

### UI режим (інтерактивний)

```bash
cd apps/web
npx playwright test --ui
```

### Debug (з breakpoints)

```bash
cd apps/web
PWDEBUG=1 npx playwright test e2e/work-orders.spec.ts
```

---

## Крок 4 — Аналіз падінь

Після запуску читаємо результати:

```bash
# Підсумок
tail -30 /tmp/pw-results.txt

# Детальний trace для першого падіння
ls apps/web/test-results/*/trace.zip 2>/dev/null | head -3
# Відкрити trace у браузері:
cd apps/web && npx playwright show-trace test-results/*/trace.zip

# Скріншоти падінь
ls apps/web/test-results/*/test-failed-*.png 2>/dev/null

# HTML звіт
# cd apps/web && npx playwright show-report playwright-report
```

### Типові причини падінь

| Симптом                                           | Причина                  | Дія                                                                 |
| ------------------------------------------------- | ------------------------ | ------------------------------------------------------------------- |
| `Timeout waiting for element`                     | Локатор не знайдено      | Перевірити селектор через MCP або headed run                        |
| `Element is outside of viewport`                  | Scroll потрібен          | Додати `page.locator(...).scrollIntoViewIfNeeded()`                 |
| `strict mode violation: multiple elements`        | Неунікальний локатор     | Додати `.first()` або більш специфічний селектор                    |
| `404 Cannot GET /api/X` на E2E                    | Stale API server         | Перезапустити API                                                   |
| `Cannot read storageState 'e2e/.auth/admin.json'` | Auth state відсутній     | Запустити globalSetup або перевірити credentials                    |
| `Invalid or unexpected token`                     | Next.js dev compile race | Spec вже має `mode: 'serial'` — перевірити `console-errors.spec.ts` |
| `net::ERR_CONNECTION_REFUSED`                     | Web сервер не запущений  | Запустити `pnpm --filter @sto/web dev`                              |
| `Test timeout of 30000ms exceeded`                | Повільний CI або API     | Збільшити timeout або перевірити чи API відповідає                  |

---

## Крок 5 — Виправлення падінь

### Причина в тесті (локатор застарів)

```bash
# Дивимось що реально в DOM через headed run
cd apps/web
npx playwright test e2e/<failing>.spec.ts --headed --slowMo=1000 2>&1 | tail -20
```

**Оновлення локатора:**

- Якщо текст кнопки змінився → оновити `has-text()`
- Якщо компонент отримав `data-testid` → перейти на `[data-testid="..."]`
- Якщо структура DOM змінилась → перевірити через MCP Playwright

### Причина в коді (регресія)

```bash
# Знайти commit що зламав
git log --oneline -10
git bisect start
```

Якщо тест перевіряє реальну поведінку (не mock) і поведінка змінилась → це баг у коді:

1. Занотувати у BUG_REPORT.md
2. Виправити код
3. Запустити тест ще раз

### Причина в auth/session

```bash
# Видалити застарілий auth state і дати globalSetup відновити
rm -f apps/web/e2e/.auth/admin.json
cd apps/web && npx playwright test --reporter=list 2>&1 | head -20
```

---

## Крок 6 — Кодогенерація нових тестів

Playwright MCP дозволяє Claude Code безпосередньо взаємодіяти з браузером:

### Через `playwright codegen`

```bash
cd apps/web
npx playwright codegen http://localhost:3001 --save-trace=/tmp/codegen-trace.zip
```

Відкриє браузер + панель з кодом. Ваші кліки → готовий Playwright тест.

### Через MCP (якщо підключений)

Якщо в сесії доступні `mcp__playwright__*` інструменти:

1. `mcp__playwright__navigate` — перейти на сторінку
2. `mcp__playwright__screenshot` — зробити скріншот поточного стану
3. `mcp__playwright__click` — клікнути по елементу
4. `mcp__playwright__fill` — заповнити поле
5. `mcp__playwright__evaluate` — виконати JS у браузері

**Алгоритм написання тесту через MCP:**

```
1. mcp__playwright__navigate → http://localhost:3001/login
2. mcp__playwright__screenshot → подивитись що є на сторінці
3. mcp__playwright__fill → заповнити email/password
4. mcp__playwright__click → натиснути Submit
5. mcp__playwright__screenshot → підтвердити redirect
6. Записати як spec у e2e/<feature>.spec.ts
```

### Шаблон нового spec-файлу

```typescript
import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

test.describe('<Назва функції>', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/<route>');
    await page.waitForLoadState('domcontentloaded');
  });

  test('<опис сценарію>', async ({ page }) => {
    // Знайти елемент
    const el = page.locator('[data-testid="..."], button:has-text("...")').first();
    await expect(el).toBeVisible({ timeout: 10_000 });

    // Взаємодіяти
    await el.click();

    // Перевірити результат
    await expect(page).toHaveURL(/\/expected-route/);
  });
});
```

---

## Крок 7 — Звіт і коміт

```bash
# Підсумок
echo "=== E2E RESULTS ==="
grep -E "passed|failed|skipped" /tmp/pw-results.txt | tail -5

# Коміт якщо були зміни у spec-файлах або фікси
git diff --name-only | grep -E "e2e/|playwright"
git add apps/web/e2e/ apps/web/playwright.config.ts
git commit -m "test(e2e): <опис змін>"
```

---

## Структура E2E suite

```
apps/web/e2e/
├── setup-auth.ts           ← globalSetup: отримує JWT + зберігає storageState
├── fixtures.ts             ← authPage fixture + loginViaAPI helper
├── smoke.spec.ts           ← публічні сторінки, статичні ресурси, security headers
├── auth-flow.spec.ts       ← login form, invalid creds, guard на 9 роутів, logout
├── work-orders.spec.ts     ← список, фільтри, модалка, картка, FSM кнопки
├── crm.spec.ts             ← список, пошук, тип-фільтр, картка (таби + баланс)
├── settings.spec.ts        ← вкладки, dark/light theme toggle
├── inventory.spec.ts       ← auth guard, mock API states
├── console-errors.spec.ts  ← 0 console.error на всіх сторінках (serial mode)
└── api-errors.spec.ts      ← resilience при 500 від API
```

**Конфіг:** `apps/web/playwright.config.ts`

- `baseURL`: `http://localhost:3001`
- `timeout`: 30s / `expect.timeout`: 8s
- `locale`: uk-UA, `timezoneId`: Europe/Kyiv
- `webServer`: автозапуск Next.js якщо не запущений
- `storageState` auth: `e2e/.auth/admin.json` (gitignored)

---

## Правила написання тестів

### DO

- `page.locator('[data-testid="..."]')` — стабільний селектор
- `.first()` якщо очікується декілька елементів
- `toBeVisible({ timeout: 10_000 })` для елементів що завантажуються з API
- `if (!(await el.isVisible({ timeout: 5_000 }))) return;` — graceful skip коли дані відсутні
- `await page.waitForLoadState('domcontentloaded')` після goto на auth сторінки
- `test.use({ storageState: 'e2e/.auth/admin.json' })` на рівні describe — не page.goto('/login')

### DON'T

- `page.waitForTimeout(5000)` — фіксований sleep; заміна: `waitForSelector` / `waitForResponse`
- `page.locator('div > span > button')` — крихкий CSS path; заміна: `has-text` або `data-testid`
- `expect(await page.locator('button').count()).toBe(3)` — крихко; заміна: `.toHaveCount()`
- Виклик реального API без mock у тестах що перевіряють error states
- `test.only` в коміті (блокує інші тести)

### Локатори по пріоритету

```
1. [data-testid="submit-btn"]         ← найстабільніший
2. role + name: getByRole('button', { name: 'Зберегти' })
3. button:has-text("Зберегти")        ← текст може мінятись при i18n
4. input[name="email"]                ← для форм
5. .className                         ← найкрихкіший, уникати
```

---

## Gotchas

- **console-errors.spec.ts** має `mode: 'serial'` — потрібно для cold Next.js compile. Не змінювати на parallel.
- **Dashboard** використовує SSE EventSource → `networkidle` ніколи не настає. Використовувати `waitUntil: 'load'`.
- **e2e/.auth/admin.json** — у `.gitignore`. CI повинен запускати globalSetup перед тестами (відбувається автоматично).
- **sessionStorage** не зберігається через `storageState` до Playwright 1.40. Наш setup-auth.ts явно патчить JSON після збереження — не видаляти цей блок.
- **MCP інструменти** (`mcp__playwright__*`) доступні тільки якщо `.mcp.json` активований у Claude Code (потрібне підтвердження "Allow for this project" при старті сесії).
- **webServer reuseExistingServer: true** — якщо Next.js вже запущений на 3001, Playwright не перезапускає. Якщо сервер "завис" — вбити вручну.

---

## Команди швидкого доступу

```bash
# Повний suite (headless)
cd apps/web && npx playwright test

# Один файл
cd apps/web && npx playwright test e2e/work-orders.spec.ts

# Один тест по назві
cd apps/web && npx playwright test --grep "валідний логін"

# Тільки failed тести (retry)
cd apps/web && npx playwright test --last-failed

# HTML звіт
cd apps/web && npx playwright show-report playwright-report

# Кодогенерація
cd apps/web && npx playwright codegen http://localhost:3001
```
