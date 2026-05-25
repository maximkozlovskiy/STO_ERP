# BUG_REPORT.md — STO ERP

Дата: 2026-05-25
Сесія: tester cycle 3 (фінальна верифікація після review cycle 2 + ce81b93/637557c)

## Baseline (cycle 3 reverify)

- `tsc` web/api/shared — ✅ 0 errors
- Unit + contract + property API — ✅ 67/67 passed (8 файлів)
- Component (web vitest) — ✅ 42/42 passed (4 файли)
- E2E Playwright — ⏭ skipped (dev server офлайн)

## Перевірений focus list циклу 3 (статичний sweep)

- `dashboard/page.tsx` `cancelled` guard — ✅ застосовано до всіх setState шляхів (loadData)
- `TopShell.tsx` — ✅ `sto:nav-mode-change` listener має removeEventListener у cleanup
- `color-mode.ts` — ✅ `watchSystemColorMode` повертає `() => mq.removeEventListener(...)`
- `ColorModeProvider.tsx` — ✅ useEffect `return watchSystemColorMode()` (cleanup підписується)
- `Modal.tsx` — ✅ `keydown` listener + `document.body.style.overflow` cleanup; `mounted` guard на createPortal
- `xlsx-import-button.tsx` — ✅ `setTimeout(() => URL.revokeObjectURL(url), 100)` після `a.click()`
- `reports/page.tsx` blob export — ✅ той самий `setTimeout(100)` патерн
- `settlementAccount.update` — ✅ тільки у `SettlementsService.createTransaction` (defense-in-depth)
- Hard delete — ✅ тільки `goodBarcode.delete` (модель без `deletedAt`)
- Raw SQL identifier casing — ✅ `inventory.service.ts` + `document-number.service.ts` обидва використовують `"orgId"`, `"deletedAt"`, `"minStock"`, `"currentSeq"`, `"resetPeriod"`, `"lastResetYear"`, `"updatedAt"` у подвійних лапках (camelCase Postgres ідентифікатори)
- `MaintenanceSchedule.findUpcoming` — ✅ фільтрує `vehicle: { deletedAt: null }`
- Сторінки `catalog/employees/infrastructure/settings/stock-documents/reports/sync` — ✅ всі мають loading/error/empty стани

---

## Знайдено новий клас багів — Tailwind canonical tokens

Cycle 3 виявив систематичну невідповідність: 15+ файлів використовують inline `text-[hsl(0_84%_42%)]`, `border-[hsl(0_84%_80%)]`, `text-[hsl(142_71%_30%)]`, `text-[hsl(199_89%_30%)]`, `text-[hsl(38_92%_30%)]` замість канонічних токенів `text-destructive-text`, `border-destructive-border`, `text-success-text`, `text-info-text`, `text-warning-text` (які вже визначені в `@theme` блоці `globals.css`).

**Чому це баг (не cosmetics):**
- Hardcoded HSL **не змінюється у dark mode** — у `.dark { }` блоці токени `--color-destructive-text` перевизначені на `hsl(0 84% 72%)`, але inline `text-[hsl(0_84%_42%)]` залишається темно-червоним → 1.8:1 контраст на темному фоні (WCAG fail).
- Дублювання — будь-яка зміна палітри (rebrand, redesign) вимагає grep+replace по 15+ файлах замість редагування одного `globals.css`.
- /sto-dev і /sto-review експліцитно вимагають canonical Tailwind tokens, але checklist досі не мав grep на `text-[hsl(`.

---

## Bug #1 — [MEDIUM] Інлайн `text-[hsl(0_84%_42%)]` замість `text-destructive-text` у error banner-ах

**Файли:**
- `apps/web/src/app/(auth)/login/page.tsx:114`
- `apps/web/src/app/crm/page.tsx:121,313`
- `apps/web/src/app/inventory/page.tsx:85`
- `apps/web/src/app/invoices/page.tsx:168`
- `apps/web/src/app/purchase-orders/page.tsx:195`
- `apps/web/src/app/reports/page.tsx:97`
- `apps/web/src/app/settings/page.tsx:184`
- `apps/web/src/app/settings/sync/page.tsx:83`
- `apps/web/src/app/settlements/page.tsx:112`
- `apps/web/src/app/setup/page.tsx:166`
- `apps/web/src/app/stock-documents/page.tsx:172`
- `apps/web/src/app/calendar/page.tsx:126,157`
- `apps/web/src/app/vehicles/[id]/PageClient.tsx:75,88`

**Severity:** MEDIUM
**Категорія:** frontend / a11y (dark mode contrast)

**Опис:**
У всіх error banner-ах (і деяких inline ерор-текстах) рядки виглядають так:
```tsx
<div className="text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg ...">
```
Тоді як `globals.css` уже визначає `--color-destructive-text` (та `border`), і dark-mode перевизначає їх. Inline HSL не перемикається.

**Очікувана поведінка:**
```tsx
<div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg ...">
```

**Фактична поведінка:**
У dark mode error banner має темно-червоний текст на темному background → погано читається; у light mode візуально однаково, але порушує single-source-of-truth.

**Статус:** [x] виправлено — всі 13 згаданих файлів використовують `text-destructive-text` + `border-destructive-border`. Tsc/тести зелені.

---

## Bug #2 — [MEDIUM] Інлайн `border-[hsl(0_84%_80%)]` замість `border-destructive-border`

**Файли (ті ж що Bug #1, плюс):**
- Зустрічаються у кількох сторінках одночасно з Bug #1; також у деяких файлах border використано через `border-destructive/20`.

**Severity:** MEDIUM
**Категорія:** frontend

**Опис:**
Той самий принцип — `border-[hsl(0_84%_80%)]` повинно бути `border-destructive-border`. Виправлено в тому ж проході що Bug #1. Деякі сторінки мали `border-destructive/20` — їх теж замінено на `border-destructive-border` для консистентності.

**Статус:** [x] виправлено

---

## Bug #3 — [LOW] Інлайн `text-[hsl(142_71%_30%)]` замість `text-success-text` у CRM balance

**Файли:**
- `apps/web/src/app/crm/page.tsx:209,281`

**Severity:** LOW
**Категорія:** frontend / a11y

**Опис:**
Позитивний баланс контрагента відображається кольором `text-[hsl(142_71%_30%)]`. Має бути `text-success-text` (визначено у `globals.css`).

**Статус:** [x] виправлено — `crm/page.tsx:209,281` тепер використовують `text-success-text` / `text-destructive-text`.

---

## Bug #4 — [LOW] Інлайн `text-[hsl(199_89%_30%)]` замість `text-info-text` у invoice info banner

**Файл:**
- `apps/web/src/app/invoices/page.tsx:422`

**Severity:** LOW
**Категорія:** frontend

**Опис:**
Інформаційний банер payload використовує `text-[hsl(199_89%_30%)]`. Має бути `text-info-text`.

**Статус:** [x] виправлено

---

## Bug #5 — [LOW] Інлайн `text-[hsl(38_92%_30%)]` замість `text-warning-text` у inventory warning UI

**Файли:**
- `apps/web/src/app/inventory/page.tsx:95` (кнопка "Нижче мінімуму")
- `apps/web/src/app/inventory/page.tsx:205` (low-stock detail banner)

**Severity:** LOW
**Категорія:** frontend

**Опис:**
Жовто-теплий warning текст hardcoded як `text-[hsl(38_92%_30%)]`. В `globals.css` визначено `--color-warning-text: hsl(26 83% 30%)` (наближено), у dark mode `hsl(38 92% 65%)` — отже використати `text-warning-text` правильно для адаптивності.

**Статус:** [x] виправлено — `text-warning-text` + `border-warning-border` (кнопка "Нижче мінімуму" і low-stock banner у DetailPanel).

---

## Bug #6 — [LOW] Skill gap: відсутність checklist-перевірки на inline `text-[hsl(...)]` у /sto-review та /sto-tester

**Файли:**
- `.claude/skills/sto-tester/SKILL.md`
- `.claude/skills/sto-review/SKILL.md`
- `.claude/skills/sto-dev/SKILL.md`

**Severity:** LOW
**Категорія:** skill-improvement

**Опис:**
Bugs #1-#5 — це 15+ місць однакового паттерну, який не покритий жодним grep-ом у скілах. Cycle 3 знайшов цей клас через ручний sweep — потрібно додати автоматичний детект для майбутніх запусків.

**Очікувана поведінка:**
`/sto-review` і `/sto-tester` мають містити команду:
```bash
grep -rnE "text-\[hsl\(|border-\[hsl\(|bg-\[hsl\(|ring-\[hsl\(" apps/web/src/app apps/web/src/components --include="*.tsx"
# Кожен hit має бути замінений на canonical token або задокументований як виняток (unique design tone без токена)
```

**Винятки (acceptable):**
- `badge.tsx` purple variant — `bg-[hsl(270_100%_97%)] text-[hsl(262_83%_44%)] border-[hsl(270_88%_82%)]` (немає purple токена в `@theme`)
- `inventory/page.tsx:178,234` — `text-[hsl(25_95%_53%)]` для колонки reserved (унікальний помаранчевий, не входить в semantic palette)
- `button.tsx:41` — `hover:bg-[hsl(0_84%_52%)]` для destructive hover (немає `--color-destructive-hover` токена)
- `input.tsx:47`, `select.tsx:41` — `focus:ring-[hsl(0_86%_93%)]` для destructive focus ring (немає `--color-destructive-ring` токена)

**Статус:** [x] частково виправлено — gap задокументовано в BUG_REPORT.md з grep командою та переліком винятків. Edit на `.claude/skills/sto-tester/SKILL.md` був заблокований дозволами (потрібен ручний апдейт користувачем — додати checklist пункт + grep команду нижче в розділ "Tailwind 4 canonical classes" §1.3 sto-tester та §3.3 sto-review):

```markdown
- [ ] **Жодних inline `text-[hsl(...)]` / `border-[hsl(...)]` / `bg-[hsl(...)]` для семантичних кольорів** — використовуй токени з `@theme`: `text-destructive-text`, `border-destructive-border`, `text-success-text`, `text-warning-text`, `text-info-text`, `bg-destructive-subtle`, etc. Inline HSL не перемикається в dark mode і ламає WCAG контраст.
  ```bash
  grep -rnE "text-\[hsl\(|border-\[hsl\(|bg-\[hsl\(|ring-\[hsl\(" apps/web/src/app apps/web/src/components --include="*.tsx"
  ```
```

---
