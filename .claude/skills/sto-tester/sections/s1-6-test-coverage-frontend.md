# sto-tester — §1.6 — Frontend тест-покриття (FULL режим)

> Частина скіла `sto-tester`. Алгоритм і матриця — у `../SKILL.md`.
> Це ПОВНИЙ перелік пунктів секції: короткі — дослівно, довгі — заголовком із кодом
> `T1.6-NNN`. Прочитай файл цілком, познач пункти, що стосуються diff-у, і дістань їхній
> повний текст (сигнал, grep-детектор, фікс) із `../journal/details-1-6.md`:
>
> ```bash
> awk '/T1.6-(007|012) -->/{f=1;next} /<!-- T1\./{f=0} f' .claude/skills/sto-tester/journal/details-1-6.md
> ```

### §1.6 — Frontend тест-покриття (FULL режим)

```bash
# Component тести
find apps/web/src -name "*.test.tsx" | sort

# E2E тести
find apps/web/e2e -name "*.spec.ts" | sort

# Playwright config
test -f apps/web/playwright.config.ts && echo "playwright OK" || echo "playwright MISSING"
```

- [ ] `Button`, `Select`, `Modal`, `Input`, `EmptyState`, `ModalTabs` — component тести існують
- [ ] Кожен **новий shared UI-компонент** (`components/ui/`) → парний `*.test.tsx` (render, інтерактив-стани, edge: порожні дані/`null`-render, badge з `0`)
- [ ] Кожен **новий custom hook** (`apps/web/src/hooks/use*.ts`) що містить `useEffect`/`useState` АБО викликає `apiFetch`/`localStorage`/`fetch` — `T1.6-001`
- [ ] `smoke.spec.ts` — обов'язковий: `/`, `/login`, `/setup` без auth, auth redirect
- [ ] Component-vs-test drift: червоний `getByText/getByRole` у baseline — правити компонент чи тест — `T1.6-002`
- [ ] Flaky component-тест: дефолтний waitFor timeout (1000ms) під повним паралельним suite (Bug #746) — `T1.6-003`
- [ ] Component-тест RHF-модалки зі схемою `.uuid()` — placeholder-id фікстури тихо блокують submit (Фаза 5, 0-баг але хибно-зелений guard) — `T1.6-004`
- [ ] Новий optional boolean prop у existing UI component (Bug #194) — `T1.6-005`
- [ ] Fake-green assertions у тестах (Bug #287) — `T1.6-006`
- [ ] jsdom browser-API стаби в `apps/web/src/__tests__/setup.ts` — `T1.6-007`
- [ ] CSS scoped marker (data-X) контракт — integration-тест на наявність маркера (Bug #334) — `T1.6-008`
- [ ] useEffect + rAF dance для CSS animation enter — 1-frame paint at previous state (Bug #335) — `T1.6-009`
- [ ] Stable callback identity invariant в composable hooks (Tester Cycle 2 2026-06-05) — `T1.6-010`
- [ ] Sibling-panel stale state після parent-action створив child resource (Bug #409) — `T1.6-011`

- [ ] Bind-once `useEffect([])` listener кличе проп напряму → stale closure (2026-09-06) — `T1.6-012`

- [ ] useCallback читає toggle-state, якого немає у deps → stale closure надсилає СТАРИЙ режим, замаскований нестабільним мок-мутацією (Bug #775) — `T1.6-013`

- [ ] Stale regression-guard test після backend-compat URL/payload fix (Bug #390) — `T1.6-014`

---
