# STO ERP — Claude Code Instructions

## Проект

STO ERP — гібридна ERP-система для автосервісів України.
**Головна вимога: повна офлайн-незалежність.** Система працює без інтернету.
Розгортання через Windows installer (.exe) на локальний ПК/сервер СТО.

## Середовище розробки

- **ОС:** Windows 10/11 + WSL2
- **IDE:** VSCode + Git Bash terminal
- **Мова інтерфейсу:** У��раїнська (кирилиця)
- **Пакетний менеджер:** pnpm (workspaces + Turborepo)

## Monorepo структура

```
sto-erp/
├── apps/
│   ├── api/          @sto/api       — NestJS 10 + Fastify (port 3000)
│   ├── web/          @sto/web       — Next.js 15 static export (port 80)
│   └── mobile/       @sto/mobile    — Expo SDK 53 + RN (offline-first)
├── packages/
│   ├── database/     @sto/database  — Prisma 5 + PostgreSQL 16
│   ├── shared/       @sto/shared    — TypeScript types, Zod schemas
│   ├── ui/           @sto/ui        — Shared React components
│   └── config/                      — ESLint, TSConfig, Vitest
├── installer/                       — Inno Setup + PowerShell
├── docs/architecture/               — ADR файли
├── docker-compose.yml               — production on-prem
├── docker-compose.dev.yml           — local development
└── CLAUDE.md
```

## Скіли — завантажувати на початку сесії

```
/sto-context    <- ЗАВЖДИ ПЕРШИМ
/sto-analyst    <- "що" потрібно: user stories, business rules, процеси (до планування)
/sto-feature    <- "як" реалізувати: DB/API/UI tasks, файли, endpoints (після analyst)
/sto-spec       <- специфікація агрегату: дос'є, BR-ID, аспектні спеки, реєстр, гейти
/sto-architect  <- архітектурні рішення (ADR), вибір технологій
/sto-database   <- зміни Prisma schema, міграції
/sto-backend    <- NestJS модулі (читай /sto-dev перед написанням)
/sto-web        <- Next.js UI (читай /sto-dev перед написанням)
/sto-mobile     <- Expo додаток
/sto-dev        <- стандарти написання коду: TS, NestJS, Next.js, Tailwind, Prisma
/sto-sync       <- синхронізація API ↔ Frontend: відсутній UI, неправильні URL, типи
/sto-review     <- code review (перевіряє що /sto-dev дотриманий)
/sto-tester     <- тестування: знаходить баги, фіксує, виправляє
/sto-e2e        <- Playwright E2E: запуск suite, кодогенерація, debug, MCP-взаємодія з браузером
/sto-optimize   <- оптимізація: N+1, індекси, паралельні запити, bundle, кеш, re-renders
/sto-installer  <- Windows installer
/sto-git        <- git: commit, branch, changelog, статус
/sto-phase      <- реалізує наступний блок фаз (database→backend→frontend→sync→QA), автоматично
```

> **Різниця sto-analyst vs sto-feature:**
>
> - `sto-analyst` = відповідає на "ЩО": формалізує вимоги, user stories, business rules, acceptance criteria. Вихід — документ вимог.
> - `sto-feature` = відповідає на "ЯК": розкладає на конкретні задачі (DB модель, API endpoint, web page), файли, оцінки. Вихід — план реалізації.
>   Типово: спочатку analyst, потім feature — але для простих змін можна одразу feature.

## Типовий workflow нової фічі

> **ПРАВИЛО: план мод обов'язковий перед реалізацією**
>
> 1. **Перед** будь-яким новим функціоналом — увійти в план мод (`/plan` або `EnterPlanMode`)
> 2. Узгодити план з користувачем (кроки, файли, рішення)
> 3. Після підтвердження — вийти з плану (`ExitPlanMode`) і реалізувати
> 4. Під час реалізації план мод **вимкнений** — просто пишемо код
>
> Це правило НЕ стосується: дрібних фіксів (1–2 файли), виправлення багів, оновлення документації.

> **ПРАВИЛО: dev-сервер обов'язковий при будь-яких змінах коду**
> Перед початком реалізації — переконатись що запущені **всі три сервери**:
>
> ```bash
> docker-compose -f docker-compose.dev.yml up -d   # БД + Redis + MinIO
> pnpm --filter @sto/api dev                        # API  → http://localhost:3000
> pnpm --filter @sto/web dev                        # Web  → http://localhost:3001
> ```
>
> Після кожної зміни UI — **перевірити у браузері** (не тільки tsc). Якщо сервер впав — перезапустити перед наступним кроком.
>
> Це правило стосується: нові сторінки, зміни компонентів, нові API endpoints, будь-які зміни що впливають на UI.

```
/plan (EnterPlanMode)
  ↓ узгодження
ExitPlanMode
  ↓ запуск dev-серверів
  ↓ реалізація + перевірка у браузері після кожного кроку
/sto-context -> /sto-analyst -> /sto-spec -> /sto-feature -> /sto-database -> /sto-dev -> /sto-backend -> /sto-web -> /sto-sync -> /sto-review -> /sto-tester -> /sto-optimize
```

> `/sto-dev` читається **перед** `/sto-backend` і `/sto-web` — задає стандарти написання,  
> щоб `/sto-review` знаходив 0 проблем.

## Автономний вибір скілів і агентів (ОБОВ'ЯЗКОВО)

> **ПРАВИЛО: скіли читаються ДО написання коду, агенти запускаються ПІСЛЯ коміту.**  
> Не чекай на команду від користувача — визначай сам за типом зміни.

### Крок 1 — визначення скілів (читай ПЕРЕД написанням)

| Тип зміни                                | Читати одразу                                 |
| ---------------------------------------- | --------------------------------------------- |
| Будь-яка зміна коду                      | `MemoryManual.md` — **першим завжди**         |
| Зміна `schema.prisma`, нова міграція     | `/sto-database` SKILL.md                      |
| Новий NestJS модуль / сервіс / контролер | `/sto-backend` SKILL.md + `/sto-dev` SKILL.md |
| Зміна наявного сервісу чи DTO            | `/sto-dev` SKILL.md (патерни)                 |
| Нове бізнес-правило агрегату             | `/sto-spec` — BR-ID + аспектний спек + реєстр |
| Новий Next.js компонент / сторінка / хук | `/sto-web` SKILL.md + `/sto-dev` SKILL.md     |
| Зміна Expo / mobile                      | `/sto-mobile` SKILL.md                        |
| Новий Inno Setup / PowerShell скрипт     | `/sto-installer` SKILL.md                     |

### Крок 2 — визначення агентів (запускай ПІСЛЯ коміту)

> **QA калібрується за розміром зміни** — не ганяти повний ланцюг на 3-рядковий фікс.

| Розмір / тип зміни                                        | QA-ланцюг                                        |
| --------------------------------------------------------- | ------------------------------------------------ |
| Дрібний фікс: 1-2 файли, косметика, a11y, текст, тайпфікс | лише `sto-review-agent`                          |
| Нова фіча · бізнес-логіка (FSM/інвентар/гроші) · ≥3 файли | `sto-review-agent` → `sto-tester-agent` (повний) |
| Змінились і backend і frontend                            | +`sto-sync-agent` ПЕРЕД review                   |
| Велика фіча / рефакторинг (>5 файлів)                     | +`sto-optimize-agent` — опціонально              |

- Усі агенти — ЗАВЖДИ через `Agent(subagent_type=...)`, ніколи inline.
- Сумнів «дрібний чи ні» → трактувати як нову фічу (повний ланцюг).
- Дрібні зміни можна **батчити**: накопичити 2-3 фікси, прогнати QA один раз наприкінці.

### Крок 3 — оновлення документації (після кожного коміту)

**`MemoryManual.md`** (тонкий, ціль ~150 рядків, поріг 200):

- `Нові файли/утиліти` → рядок, якщо з'явилась нова утиліта/скрипт/агент
- `Активні особливості` → правити, якщо змінилась логіка, яку не видно з коду
- `Поточний стан` → лише дата і фаза

**Хеші й цифри у MemoryManual НЕ зберігаються.** Старіють швидше, ніж файл оновлюється:
2026-10-05 там лежало «301 роут із 422», а `count-untyped-routes.py` давав 310 — читач
отримував неправду. Хеш точніший з `git log`, цифри — з `scripts/measure.sh`.

Саме дописування замість заміни роздуло файл до 886 рядків при цілі 150
(`Поточний стан` 524 + `Останній commit` 272). Якщо файл перейшов 200 — перечитати це правило.

**`CHANGELOG.md`** — append нового запису (3–5 рядків):

- `### <hash> <type>(<scope>): <message>` + ключові зміни

**Довідники** (оновлювати за потреби, не щоразу):

- Нова пастка/gotcha → `docs/GOTCHAS.md` (prepend зверху)
- Новий патерн/компонент → `docs/PATTERNS.md`
- Зміна бізнес-правил/FSM → `docs/BUSINESS-RULES.md`
- Новий модуль/модель → `docs/ARCHITECTURE.md`

**`docs/objects/<entity>.md`** — оновлювати якщо зачеплено відповідний агрегат:

| Зміна в коді                                    | Оновити дос'є               |
| ----------------------------------------------- | --------------------------- |
| Новий endpoint у controller                     | секція "API Endpoints"      |
| Нове поле або зв'язок у Prisma schema           | секція "Prisma модель"      |
| Новий FSM-статус або transition                 | секція "FSM" + side-effects |
| Новий компонент або сторінка для цього агрегату | секція "UI (Web)"           |
| Нове бізнес-правило специфічне для агрегату     | секція "Бізнес-правила"     |

Таблиця відповідності агрегат → файл:

```
WorkOrder       → docs/objects/work-order.md
Invoice         → docs/objects/invoice.md
PurchaseOrder   → docs/objects/purchase-order.md
StockDocument   → docs/objects/stock-document.md
Counterparty    → docs/objects/counterparty.md
Good            → docs/objects/good.md
Work/WorkCategory → docs/objects/work.md
CalendarSlot    → docs/objects/calendar.md
StockItem/StockMovement → docs/objects/inventory.md
SettlementAccount/Transaction → docs/objects/settlements.md
BankTransaction → docs/objects/bank-statements.md
```

**НЕ** дублювати деталі між файлами — одне місце правди.

> Виняток скілів: якщо запит є скіл-командою (`/sto-database`) — скіл вже завантажений, не читай повторно.  
> Виняток агентів: якщо сам запит був review або tester — не запускати рекурсивно.

## Агенти (project-level, запускати через Agent tool)

`.claude/agents/` містить готових агентів з власними системними промптами:

```
sto-sync-agent     ← API/Frontend sync: відсутній UI, неправильні URL, типи (auto, після backend+web)
sto-review-agent   ← code review + авто-фікс (завжди через Agent tool)
sto-tester-agent   ← bug hunt + авто-фікс (завжди через Agent tool)
sto-optimize-agent ← performance аудит + авто-фікс: N+1, кеш, індекси, bundle, re-renders
sto-claims-auditor ← перевіряє ТВЕРДЖЕННЯ головного агента по транскрипту (не по доповіді);
                     перед підсумковим звітом і обов'язково перед «усе ок / можна релізити»
```

**ПРАВИЛО:** `sto-sync`, `sto-review`, `sto-tester`, `sto-optimize` ЗАВЖДИ запускати через `Agent(subagent_type=...)` — НЕ як inline скіли. Захищає основний контекст від переповнення.

```python
# Повний QA ланцюжок після backend+frontend змін:
Agent(subagent_type="sto-sync-agent", description="sync after <block>")
# після завершення:
Agent(subagent_type="sto-review-agent", description="code review cycle N")
# після завершення:
Agent(subagent_type="sto-tester-agent", description="bug hunt cycle N")
# після завершення (опціонально, після великих фіч):
Agent(subagent_type="sto-optimize-agent", description="perf audit after <block>")

# Якщо тільки backend АБО тільки frontend — sto-sync-agent пропускається
# Паралельно: review і tester НІКОЛИ не паралельно — tester потребує результатів review
# sto-optimize-agent можна запускати паралельно з tester якщо незалежні зміни
```

## Вердикт і цифри — лише з інструмента (ОБОВ'ЯЗКОВО)

> Правило з'явилось після аудиту 2026-10, де заявлена цифра розійшлася з виміряною
> **сім разів**, а «E2E чистий» було сказано на прогоні з **15 падіннями** (Playwright
> надрукував `15 failed` вище за `276 passed`, і exit code був **0**).

**1. Слово «чисто» не вимовляється з голови.** Вердикт дає `scripts/verdict.sh`:

```bash
npx vitest run 2>&1 | bash scripts/verdict.sh "api unit"
bash scripts/verdict.sh --cmd "api tsc" -- npx tsc --noEmit -p tsconfig.json
bash scripts/verdict.sh --file /шлях/до/лога "E2E"        # для фонових прогонів
```

Контракт: `exit 0` лише якщо є ознака успіху І немає ознаки падіння. **Невідоме ≠ чисто** —
порожній/нерозпізнаний вивід теж дає `exit 1`. Скрипт називає flaky окремо: «0 failed»
при 6 flaky — це не «чисто», це «пройшло з retry».

**ЧОМУ exit code недостатньо:** Playwright віддав `0` при 15 падіннях. Тому текст виводу
має пріоритет над кодом, а не навпаки.

**2. Цифра в тексті/документі/коміті — лише з `scripts/measure.sh`:**

```bash
bash scripts/measure.sh            # тести + E2E + роути + розмір доків
bash scripts/measure.sh e2e        # окремо
```

Заборонено: `grep -c "it("` (рахує коментарі, `it.each` як 1 замість N),
`grep -c "test("` (рахує `test.describe` → «450» замість 354),
`grep -c "useMutation"` (рахує рядок `import`), сумування цифр зі звітів агентів.

**3. Перед підсумковим звітом користувачу — `Agent(subagent_type="sto-claims-auditor")`.**
Обов'язково перед «усе ок», «можна релізити», «цикл чистий». Агент читає ТРАНСКРИПТ
(`scripts/audit-claims.py`), а не мою доповідь — бо доповідь містить лише те, що я САМ
помітив як сумнівне, а всі чотири помилки аудиту були там, де я не сумнівався.

**4. Заміри часу — лише через `127.0.0.1`, НЕ `localhost`.** На Windows `localhost`
додає ~213 мс на connect (IPv6 → fallback IPv4). Один раз це дало «217 мс» там, де
насправді 4 мс — помилка в 60 разів. Деталі: `docs/PERFORMANCE-BASELINE.md`.

**5. Правило 1–3 тримається Stop-hook'ом, а не моєю пам'яттю.**
`scripts/hooks/check-claims-verified.py` (підключений у `.claude/settings.json`,
подія `Stop`) читає відповідь перед відправкою. Якщо в ній є вердикт або цифра-
твердження, а в ЦЬОМУ ході не було ні `sto-claims-auditor`, ні `verdict.sh`/
`measure.sh` — завершення блокується (`exit 2`), і stderr повертається мені
списком тверджень, що потребують доказу.

ЧОМУ механічно: те саме правило у прозі («review і tester ніколи не паралельно»)
я порушив у тій самій сесії, де його прочитав. Правило, що тримається на
прочитанні, працює доти, доки контекст не заповнений.

Hook НЕ оцінює правдивість — лише питає «чим виміряв». Три виходи з блокування:
аудитор, прогін скрипта, або прямо сказати, що цифра не перевірена цього ходу.
Блокує максимум раз на хід (`stop_hook_active` + маркер у temp), щоб не зациклитись.

**6. `git commit --no-verify` — ЗАБОРОНЕНО без явного прохання користувача.**
`--no-verify` пропускає husky + lint-staged, тобто `prettier --write` і `eslint --fix`
на staged-файлах. Хук триває ~3 секунди.

2026-10-05 я зробив **9 комітів підряд** із `--no-verify` (`d7b330b7..c679b960`).
Наслідок не гіпотетичний:
два `.md` лишились неформатованими, причому вирівнювання таблиці я САМ побачив і
відкинув як косметику — хук виправив би його без мого рішення.

`.lintstagedrc.js` цей сценарій прямо передбачав: «повний tsc у хук свідомо НЕ додано
... інакше хук почали б обходити через `--no-verify`». Обійшов саме так.

Якщо хук падає — читати ЧОМУ і виправляти причину, а не обходити. Виняток один:
користувач попросив прямо.

**7. «Немає» про прапорець, опцію чи поле — лише ПІСЛЯ виклику, не після grep-у.**
2026-10-05 я двічі заявив, що прапорця у 2.1.148 немає, бо не знайшов рядка у
`claude --help` — і двічі помилився: `--system-prompt-file` і `--bg` бінарник приймає.
`--help` не перелічує всі прапорці (а `--system-prompt[-file]` там навіть згаданий у
тексті про `--bare`, і я його прочитав, не побачивши).

Протокол — ТРИ кроки, бо без контролю тест нічого не доводить:

```bash
claude <прапорець> auth status              # цільовий
claude --totally-fake-flag-zzz auth status  # КОНТРОЛЬ: мусить дати "unknown option"
```

**Відсутність у документації ≠ відсутність у реалізації.** Формулювання
«не задокументовано» припустиме завжди; «немає» / «вигадка» — лише після виклику.
Це важливо подвійно, коли висновок стосується роботи іншого агента: я назвав
двох агентів-дослідників фабрикаторами, і це було неправдою.

## Автоматичне QA після кожного завдання (ОБОВ'ЯЗКОВО)

Після завершення **будь-якого** завдання і git commit — виконай **послідовно**:

```
0. [якщо чіпав тести] → python scripts/check-spec-registry.py --gate-size --gate-registry
1. [якщо змінились frontend і backend] → Agent(sto-sync-agent)
2. → Agent(sto-review-agent)   — code review, виправити всі знайдені проблеми
3. → Agent(sto-tester-agent)   — тести, BUG_REPORT.md, виправити всі баги
4. → Оновити документацію: MemoryManual.md (commit + стан) + CHANGELOG.md (append) + довідник якщо знайдено нову пастку
```

**Крок 0 — чому він перший.** Гейти дешеві (секунди) і ловлять те, чого не бачать
агенти: новий моноліт (>900 рядків і ≥2 top-level `describe`), зниклий кейс проти
`apps/api/test-baseline.json`, і файл, названий у реєстрі дос'є, але відсутній на диску.
Якщо додав/змінив тести — спершу вони, потім усе інше.

Додав тест → оновити число кейсів у реєстрі `docs/objects/<entity>.md` і baseline:

```bash
cd apps/api && npx vitest run --reporter=json --outputFile=.vitest-report.json
python ../../scripts/spec-baseline.py .vitest-report.json --out test-baseline.json
```

Baseline правиться **лише цим скриптом** — тоді diff показує рівно ті кейси, що
змінились. Деталі моделі — `/sto-spec`.

> Виняток: якщо сам запит був review або tester агент — не запускати рекурсивно.

## Безперервне вдосконалення скілів (ОБОВ'ЯЗКОВО)

Після кожного запуску `/sto-review` або `/sto-tester` — запитай себе:

> "Цей баг/проблема були охоплені існуючим чеклістом?"

Якщо **НІ** — одразу оновити відповідний скіл:

- Новий патерн помилки → додати до `/sto-dev` (❌/✅ приклад) + `/sto-review` (checklist item)
- Новий grep для автоматичного виявлення → додати bash команду в `/sto-review`
- Бізнес-логіка специфічна для STO ERP (FSM, інвентар, розрахунки) → `/sto-dev` Business Rules + `/sto-review`
- Tailwind/TS/Prisma паттерн → тільки `/sto-dev` (одне місце правди)
- Commit: `docs(skills): add <pattern> check to sto-dev/sto-review/sto-tester`

Скіли мають відображати **реальні баги які траплялись** — не гіпотетичні.

### Профілактична консолідація скілів (щоб не роздувались)

Накопичення знань роздуває скіли (sto-tester доходив до 4478 рядків). При старті сесії
перевіряти розмір і стискати ПРОФІЛАКТИЧНО, а не разовою чисткою:

```bash
for d in .claude/skills/*/; do wc -l "$d/SKILL.md"; done | sort -rn | head -4
```

- Скіл **>1500 рядків** → запустити консолідацію (агент читає повністю, стискає прозу й
  дублювання, зберігає ВСІ номери багів / grep-детектори / checklist-пункти / ❌✅ приклади).
- Консолідація стискає, **не видаляє знання** — кожен унікальний патерн лишається.
- Коміт: `docs(skills): консолідація <skill> (NNNN→MMMM рядків, знання збережено)`.

## Відновлення після ліміту / нова сесія

Після відновлення (rate limit, новий контекст, нова сесія):

1. Прочитати `MemoryManual.md` — поточний стан, останній commit, посилання
2. Прочитати `docs/PHASES.md` — де зупинились
3. Прочитати `.claude/memory/MEMORY.md` — preferences
4. За потреби — відкрити довідник: `docs/ARCHITECTURE.md`, `docs/PATTERNS.md`, `docs/BUSINESS-RULES.md`, `docs/GOTCHAS.md`
   - Якщо торкаєшся конкретного агрегату → прочитати його `docs/objects/<entity>.md`
5. Продовжити з місця зупинки без питань

> **ПРАВИЛО: завершений план — одразу в архів.**
> `/sto-context` трактує найновіший `.md` у теці планів як «незавершену задачу з
> контекстом». Якщо план реалізований, а файл лишився — кожна нова сесія стартує з
> читання зробленої роботи як незробленої. Так сталося з OCR-планом: реалізований
> 2026-10-02, а файл лежав активним ще три дні (170 рядків марного контексту щосесії).
>
> Тому: щойно останній крок плану закомічено — перенести файл у підтеку `done/`
> ТОЇ Ж теки планів (вона ПОЗА репозиторієм: `~/.claude/plans/`, не `plans/` у проєкті). Саме перенести, не видаляти: план лишається читабельним
> як історія рішень, але `/sto-context` його вже не підхоплює (він дивиться лише
> корінь теки).
>
> Сумнів «чи точно завершено» перевіряється **по коду** — чи існують файли й функції,
> які план обіцяв, — а не по пам'яті.
>
> 2026-10-05 у `done/` перенесено 16 планів, але **по коду перевірено 7 із них**, і це
> була вибірка, не повна перевірка: OCR — ґрунтовно (`ocr-text-layer.provider.ts`,
> `pdf-rasterizer.ts`, `mergeWordsIntoCells` у 4 місцях, ліміт 25 МБ у `main.ts:55`),
> ще 6 — одним `[ -f <файл> ]` (Nova Poshta, monobank QR, Checkbox ПРРО, money-model,
> cash-operations, eSputnik). Решта 8 перенесені **за датою** (усі з вересня), без
> перевірки коду. Якщо колись знадобиться — вони в `done/`, не втрачені.

## Критичні правила (ОБОВ'ЯЗКОВО)

### Офлайн-незалежність

1. **Зовнішні API** (SMS, ПРРО, прайси) — тільки через BullMQ чергу, ніколи прямий виклик
2. **Черга з retry** — attempts >= 10, backoff exponential; для ПРРО attempts=288 (24 год)
3. **Система не зупиняється** при відсутності інтернету

### База даних

4. **Кожна таблиця** має: `id` (UUID), `orgId`, `createdAt`, `updatedAt`, `deletedAt`, `syncVersion`
5. **Soft delete скрізь** — ніколи `prisma.X.delete()`, тільки `{ deletedAt: new Date() }`
6. **Кожен запит** фільтрується по `orgId` (tenant isolation)

### Бізнес-логіка

7. **Зміни залишків** — тільки через `InventoryService.createMovement()`
8. **Зміни балансу** — тільки через `SettlementsService.createTransaction()`
9. **FSM нарядів** — тільки через transition map у `WorkOrdersService.transition()`

### Конфігурованість (Configuration over Hardcode)

10. **Налаштування в БД** — терміни, ліміти, шаблони, способи оплати -> моде��і `OrganisationSettings`, `BranchSettings`, `NotificationTemplate`, `PaymentMethodConfig`, `TaxRate`
11. **ПРРО та SMS** -> `BranchSettings` (per branch), НЕ тільки в `.env`
12. **Нумерація документів** -> `DocumentNumberConfig`, ніяких hardcoded форматів у коді
13. **Ніяких magic numbers у коді** — `invoiceDueDays`, `autoArchiveDays`, `warrantyDays`, `slotDurationMinutes` читаються з БД через `SettingsService.get(orgId)`
14. **Шаблони повідомлень** — текст SMS/Viber/Email тільки з `NotificationTemplate`, не рядкові літерали у сервісах

### UI

15. **Весь UI** — українською мовою (кирилиця)
16. **Валідація** (Zod) — повідомлення українською
17. **API помилки** — українською

## ADR — прийняті архітектурні рішення

| Файл    | Рішення                                       |
| ------- | --------------------------------------------- |
| ADR-001 | Local-first offline architecture              |
| ADR-002 | Docker Compose як одиниця розгортання         |
| ADR-003 | Inno Setup + PowerShell для Windows installer |
| ADR-004 | WatermelonDB для offline-first mobile         |
| ADR-005 | BullMQ черга для зовнішніх API                |
| ADR-006 | Опціональна cloud sync (Outbox Pattern)       |
| ADR-007 | Стратегія автоматичного оновлення             |
| ADR-010 | Row-Level Security — розглянуто, відкладено   |

## Запуск (розробка)

```bash
docker-compose -f docker-compose.dev.yml up -d
pnpm dev
# API:    http://localhost:3000/api/docs
# Web:    http://localhost:3001
# Mobile: pnpm --filter @sto/mobile start
# DB:     cd packages/database && pnpm prisma studio
```

## Локаль та форматування

- Мова: `uk-UA` | Timezone: `Europe/Kyiv`
- Валюта: `UAH`, формат: `1 250,00 грн`
- Дата: `DD.MM.YYYY` | Час: `HH:mm` (24-год)
- Тиждень: починається з понеділка
