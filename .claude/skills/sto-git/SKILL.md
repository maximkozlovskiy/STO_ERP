---
name: sto-git
description: >
  Git workflow for STO ERP: commit with conventional messages, branch management, status overview,
  and changelog generation. Use when the user says "закомітити", "зроби commit", "покажи статус",
  "створи гілку", "що змінилось", "зроби changelog", "git", або будь-що пов'язане з git.
  NOTE: for changelog/release notes tasks use claude-sonnet-4-6 instead of haiku.
model: claude-haiku-4-5-20251001
---

# sto-git — Git Workflow Skill

## Перший крок: визначити задачу

Залежно від запиту користувача виконай одну з дій нижче:

| Запит | Дія | Модель |
|-------|-----|--------|
| "закомітити", "зроби commit", "commit changes" | → [Commit Flow](#commit-flow) | haiku |
| "покажи статус", "що змінилось", "git status" | → [Status Overview](#status-overview) | haiku |
| "створи гілку", "нова гілка", "checkout" | → [Branch Management](#branch-management) | haiku |
| "зроби changelog", "що нового", "release notes" | → [Changelog](#changelog) | **sonnet** — складний аналіз |
| "покажи лог", "git log", "що було зроблено" | → [Log Overview](#log-overview) | haiku |

> **Changelog/Release Notes** — єдина задача де складності недостатньо для haiku: потрібно кластеризувати commit-и за темами, вибрати найважливіше, написати human-readable summary. Для решти git-операцій haiku достатньо.

---

## Status Overview

Виконай паралельно:
```bash
git status
git diff --stat
git log --oneline -10
```

Виведи:
- Які файли змінені (M), нові (??)
- Кількість змінених рядків
- 10 останніх комітів
- Поточна гілка

---

## Commit Flow

### 1. Зібрати інформацію

Виконай паралельно:
```bash
git status
git diff
git log --oneline -5
```

### 2. Проаналізувати зміни

Розбий зміни по категоріях:
- `feat` — нова функціональність
- `fix` — виправлення багів
- `refactor` — рефакторинг без зміни поведінки
- `chore` — конфіги, залежності, CI
- `docs` — документація
- `test` — тести
- `db` — зміни схеми Prisma / міграції

### 3. Сформулювати повідомлення коміту

```
<type>(<scope>): <короткий опис українською або англійською>

[опціонально: деталі якщо зміни нетривіальні]
```

**Scope** — назва модуля або підсистеми:
- `auth`, `settings`, `work-orders`, `inventory`, `finance`, `crm`, `catalog`
- `web`, `mobile`, `installer`, `database`, `shared`
- `docker`, `ci`

**Приклади:**
```
feat(settings): SettingsService з Redis-кешем + DocumentNumberingService

- SettingsService: OrganisationSettings + BranchSettings з TTL=5хв
- DocumentNumberingService: атомарний SELECT FOR UPDATE
- PaymentMethodsModule: CRUD методів оплати
- SetupModule: POST /setup/init (wizard першого запуску)
```

```
feat(web): wizard першого запуску + сторінка налаштувань
```

```
fix(auth): видалено застарілі .js файли з src/ що заважали vitest
```

```
chore(database): додано AuthAccount модель + міграція
```

### 4. Staging і commit

```bash
# Додавати конкретні файли — ніколи git add -A без перевірки
git add <файли або папки>
git status  # перевірити що staged
git commit -m "$(cat <<'EOF'
feat(scope): опис

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

### 5. Після коміту — оновити MemoryManual.md

Після кожного успішного коміту **ОБОВ'ЯЗКОВО** оновити `MemoryManual.md` у корені проєкту:

```bash
git log --oneline -3  # підтвердити що комі�� створено
```

Потім відкрий `MemoryManual.md` і:

1. **Оновити блок "Останній commit"** — новий хеш і повідомлення, дата
2. **Додати рядок у "Changelog"** — `| \`<hash>\` | <повідомлення> |`
3. **Оновити "Поточний стан"** якщо змінились TypeScript статус, тести, або фаза
4. **Оновити відповідний розділ** якщо:
   - додано новий модуль → до таблиці "Всі API модулі"
   - додано нову сторінку → до списку `apps/web/src/app/`
   - додано новий компонент → до `apps/web/src/components/`
   - нове бізнес-правило або gotcha → до відповідного розділу
   - новий скіл → до таблиці скілів

```bash
git add MemoryManual.md
git commit -m "docs(memory): update MemoryManual after <short description>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Branch Management

### Поточний стан гілок
```bash
git branch -a
git log --oneline main..HEAD  # що є в поточній гілці але немає в main
```

### Конвенція назв гілок для STO ERP

```
feature/<phase>-<short-description>
  feature/phase3-settings-module
  feature/phase4-branches-crud

fix/<what-was-fixed>
  fix/auth-stale-js-files
  fix/prisma-migration-lock

chore/<what>
  chore/update-deps
  chore/docker-compose-redis
```

### Створити гілку
```bash
git checkout -b feature/<name>
```

### Злити в main (після завершення фази)
```bash
git checkout main
git merge --no-ff feature/<name> -m "feat: <Phase N> — <назва фази>"
git branch -d feature/<name>
```

---

## Changelog

Генерує нотатки для релізу або між двома гілками/тегами.

```bash
git log --oneline v0.1.0..HEAD  # або main..HEAD
```

Формат changelog:

```markdown
## [0.2.0] — 2026-05-22

### Нове
- feat(auth): JWT login/refresh, AuthAccount, seed admin@sto.local
- feat(settings): SettingsService Redis-кеш, DocumentNumberingService
- feat(web): wizard першого запуску, сторінка налаштувань

### Виправлення
- fix(api): видалено застарілі .js файли з src/

### Технічне
- chore(database): AuthAccount модель, міграція add_auth_account
- chore(ci): pnpm allowBuilds для @swc/core
```

---

## Log Overview

```bash
git log --oneline --graph --all -20
```

Виведи структуровано:
- Останні коміти з хешем і повідомленням
- Які гілки є і де вони відносно main
- Чи є uncommitted changes

---

## Правила для STO ERP

1. **Ніколи не комітити** `.env`, `.env.dev`, `installer/bundle/`, `*.tar.gz`
2. **Ніколи не комітити** `apps/api/src/**/*.js` (скомпільовані файли в src)
3. **Завжди перевіряти** `git status` перед `git add`
4. **Коміт після кожної фази — ОБОВ'ЯЗКОВО** — як тільки всі задачі фази `[x]`, одразу комітити без запиту
5. **Не force push** на main — якщо потрібно виправити, новий коміт
6. **Повідомлення** — можна українською або англійською, головне — зрозуміло

## Автоматичний коміт після фази

Коли `/sto-context` виявляє що всі задачі поточної фази `[x]` — виконати без запиту:

```bash
git status
git diff --stat

# Додати все крім виключень
git add apps/api/src/ apps/web/src/ apps/mobile/
git add packages/
git add docs/PHASES.md docker-compose*.yml CLAUDE.md installer/inno/ installer/scripts/
# НЕ додавати: .env, .env.dev, installer/bundle/, dist/, *.js в src/

git commit -m "$(cat <<'EOF'
feat(phaseN): <назва фази українською>

- <ключова зміна 1>
- <ключова зміна 2>
- <ключова зміна 3>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

**Формат назви фази:**
- `feat(phase0): bootstrap — монорепо та інфраструктура`
- `feat(phase1): повна схема БД`
- `feat(phase2): автентифікація`
- `feat(phase3): налаштування та перший запуск`
- і т.д.

## Типова сесія після завершення фази

```bash
# 1. Переглянути всі зміни
git status
git diff --stat

# 2. Додати змінені файли (не .env, не dist, не bundle)
git add apps/api/src/
git add apps/web/src/
git add packages/
git add docs/PHASES.md
git add docker-compose*.yml  # якщо змінились

# 3. Закомітити
git commit -m "feat(phase3): налаштування та перший запуск

- SettingsService: Redis-кеш OrganisationSettings + BranchSettings (TTL=5хв)
- DocumentNumberingService: атомарна нумерація SELECT FOR UPDATE
- SettingsModule: GET/PATCH /settings/{organisation,branch/:id}
- PaymentMethodsModule: CRUD /payment-methods
- SetupModule: GET /setup/status + POST /setup/init
- Web: /setup wizard 5 кроків, /settings UI

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
