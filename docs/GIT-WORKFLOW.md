# STO ERP — Git Workflow

> Правила роботи з репозиторієм. Claude Code читає цей файл при створенні гілок та формуванні commit повідомлень.

---

## 1. Стратегія гілок

```
main
  └── develop
        ├── feature/WO-123-add-work-order-fsm
        ├── feature/INV-45-stock-movement-service
        ├── fix/WO-89-transition-guard-bug
        ├── chore/update-prisma-to-5-15
        └── docs/add-erd-diagram
```

### Правила гілок

| Гілка | Призначення | Звідки | Куди |
|-------|-------------|--------|------|
| `main` | Production-ready код | `develop` (через PR) | — |
| `develop` | Інтеграційна гілка | `feature/*`, `fix/*` | `main` |
| `feature/*` | Нова функціональність | `develop` | `develop` |
| `fix/*` | Виправлення помилок | `develop` | `develop` |
| `hotfix/*` | Критичне виправлення у production | `main` | `main` + `develop` |
| `chore/*` | Залежності, конфіг, інфраструктура | `develop` | `develop` |
| `docs/*` | Тільки документація | `develop` | `develop` |

### Заборонено

- Прямий push у `main` або `develop`
- Гілки без префіксу (наприклад, просто `work-orders`)
- Гілки що живуть більше 1 тижня без PR

---

## 2. Commit Convention

Формат: `<тип>(<область>): <опис>`

```
feat(work-orders): додати FSM перехід IN_PROGRESS → ON_HOLD
fix(inventory): виправити атомарне оновлення StockItem кількості
chore(deps): оновити prisma до 5.15.0
docs(architecture): додати ERD діаграму
refactor(settlements): виділити createTransaction в окремий метод
test(work-orders): покрити тестами всі FSM переходи
style(web): виправити відступи у WorkOrderCard
perf(api): додати індекс на work_orders(orgId, status)
```

### Типи

| Тип | Коли використовувати |
|-----|---------------------|
| `feat` | Нова функціональність |
| `fix` | Виправлення помилки |
| `chore` | Залежності, збірка, конфіг (без впливу на логіку) |
| `docs` | Тільки документація |
| `refactor` | Рефакторинг без зміни поведінки |
| `test` | Додавання або виправлення тестів |
| `style` | Форматування, відступи (без логіки) |
| `perf` | Оптимізація продуктивності |
| `revert` | Відкат попереднього коміту |

### Області (scope)

```
work-orders, inventory, settlements, crm, catalog, calendar,
auth, api, web, mobile, database, shared, installer, docker, docs
```

### Правила опису

- Мова: **українська** (кирилиця)
- Починається з дієслова в інфінітиві: `додати`, `виправити`, `видалити`, `оновити`
- Не більше 72 символів
- Без крапки в кінці

### Breaking changes

```
feat(api)!: змінити формат відповіді пагінації

BREAKING CHANGE: поле `data` перейменовано на `items`
```

---

## 3. Правила роботи з гілками

### Створення нової фічі

```bash
# Від develop
git checkout develop
git pull origin develop
git checkout -b feature/WO-123-назва-фічі

# Робота...
git add .
git commit -m "feat(work-orders): додати валідацію guard умов при переходах"

# Синхронізація з develop перед PR
git fetch origin develop
git rebase origin/develop

# Push
git push origin feature/WO-123-назва-фічі
```

### Rebase vs Merge

- **Feature гілки → develop:** `rebase` (чиста лінійна історія)
- **develop → main:** `merge --no-ff` (зберігає момент інтеграції)
- **Ніколи:** `git merge develop` у feature гілку (тільки rebase)

---

## 4. Pull Request шаблон

Файл: `.github/pull_request_template.md`

```markdown
## Опис

<!-- Що зроблено і навіщо -->

## Тип зміни

- [ ] feat — нова функціональність
- [ ] fix — виправлення помилки
- [ ] refactor — рефакторинг
- [ ] chore / docs

## Пов'язані задачі

Closes #...

## Що перевірити

- [ ] Unit тести написані та проходять (`pnpm test`)
- [ ] Типи перевірені (`pnpm type-check`)
- [ ] Lint проходить (`pnpm lint`)
- [ ] CLAUDE.md правила не порушені
- [ ] Якщо є зміни схеми — міграція створена
- [ ] Якщо є нові env змінні — оновлено ENV-REFERENCE.md та .env.example
- [ ] Якщо є зміни FSM — оновлено FSM.md
- [ ] Swagger документація актуальна

## Скріншоти (якщо є UI зміни)

<!-- Додати скріншоти до/після -->
```

---

## 5. Правила злиття

### Feature → Develop

- Мінімум 1 approving review (або self-merge для solo розробки)
- Всі checks проходять (lint, type-check, tests)
- Squash merge з описовим повідомленням

### Develop → Main (реліз)

- Всі тести проходять
- Версія оновлена в `package.json`
- `CHANGELOG.md` оновлено
- Merge commit (без squash) — щоб зберегти окремі commit'и

---

## 6. Версіонування

Формат: `MAJOR.MINOR.PATCH` (SemVer)

| Версія | Коли |
|--------|------|
| `PATCH` (0.1.**1**) | Bug fix, хотфікс |
| `MINOR` (0.**2**.0) | Нова функціональність, зворотньо сумісна |
| `MAJOR` (**1**.0.0) | Breaking change, несумісна зміна API/БД |

### Теги

```bash
git tag -a v0.1.0 -m "Реліз v0.1.0: базовий модуль нарядів"
git push origin v0.1.0
```

---

## 7. CHANGELOG.md

```markdown
# Changelog

## [0.2.0] — 2024-06-15

### Added
- Модуль взаєморозрахунків (SettlementAccount, SettlementTransaction)
- Акт звірки з клієнтом
- FSM для Invoice (DRAFT → SENT → PAID)

### Fixed
- Виправлено атомарність оновлення залишків при одночасному списанні

### Changed
- Формат відповіді пагінації: `data` → `items`

## [0.1.0] — 2024-05-21
### Added
- Базовий модуль нарядів (WorkOrder, WorkOrderLine, WorkOrderPart)
- FSM наряду (DRAFT → ARCHIVED)
- Модуль CRM (Counterparty, CustomerGarage, Vehicle)
```

---

## 8. .gitignore (ключові записи)

```gitignore
# Env
.env
.env.local
.env.production
!.env.example

# Build
dist/
.next/
out/

# Prisma
packages/database/prisma/migrations/*.sql  # НЕ ігноруємо! Міграції комітимо

# Logs
logs/
*.log

# OS
.DS_Store
Thumbs.db
```

---

## 9. Швидкі команди

```bash
# Статус та різниця
git status
git diff --stat origin/develop

# Перегляд лог
git log --oneline --graph --decorate -20

# Відкат останнього коміту (зберегти зміни)
git reset --soft HEAD~1

# Перемістити зміни на нову гілку (якщо почав не там)
git stash
git checkout -b feature/правильна-гілка
git stash pop

# Виправити останній commit message
git commit --amend -m "fix(work-orders): виправити повідомлення помилки"

# Інтерактивний rebase (squash декілька комітів)
git rebase -i origin/develop
```

