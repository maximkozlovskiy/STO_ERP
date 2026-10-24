# sto-tester — §1.4 — Security (FULL режим)

> Частина скіла `sto-tester`. Алгоритм і матриця — у `../SKILL.md`.
> Це ПОВНИЙ перелік пунктів секції: короткі — дослівно, довгі — заголовком із кодом
> `T1.4-NNN`. Прочитай файл цілком, познач пункти, що стосуються diff-у, і дістань їхній
> повний текст (сигнал, grep-детектор, фікс) із `../journal/details-1-4.md`:
>
> ```bash
> awk '/T1.4-(007|012) -->/{f=1;next} /<!-- T1\./{f=0} f' .claude/skills/sto-tester/journal/details-1-4.md
> ```

### §1.4 — Security (FULL режим)

```bash
# SSRF guard на webhook/external URL
grep -rn "validatePublicUrl\|url-guard" apps/api/src/modules/ --include="*.ts" | grep -v spec | head -10

# fetch без redirect: 'manual' на user-supplied URL
grep -rn "fetch(.*url\|fetch(dto\." apps/api/src/modules/ --include="*.ts" | grep -v "redirect:\|spec" | head -5

# Bug #273: validatePublicUrl присутній АЛЕ redirect: 'manual' відсутній — defense-in-depth NOT PAIRED.
# Сценарій атаки: validatePublicUrl блокує DIRECT внутрішні URL (127.0.0.1, link-local),
# але атакувальник з OWNER правом ставить legit external host attacker.com → attacker.com
# відповідає 302 Location: http://169.254.169.254/... → default fetch (redirect:'follow')
# слідує redirect → POST з Authorization header летить у privately-routed VPC. Bypass.
# Кожен файл що має ВЖЕ validatePublicUrl (або викликає fetch на user-controlled host) ПОВИНЕН
# мати парний `redirect: 'manual'` + 3xx-rejection guard:
for f in $(grep -l "validatePublicUrl\|branchSettings\.\|dto\.url\|dto\.webhookUrl\|endpoint\.url" \
            apps/api/src/modules --include="*.ts" -r | grep -v spec); do
  if grep -q "fetch(" "$f" && ! grep -q "redirect:\s*'manual'" "$f"; then
    echo "BUG #273 MISSING: $f has fetch() to user-supplied host but no redirect: 'manual'"
  fi
done

# @IsArray без @ArrayMaxSize
grep -rn "@IsArray()" apps/api/src/modules/ --include="*.dto.ts" -A 2 | grep -v "ArrayMaxSize" | head -10

# @IsString без @MaxLength (DoS)
grep -rn "@IsString()" apps/api/src/modules/ --include="*.dto.ts" | grep -v "MaxLength\|IsIn\|IsEmail\|IsUrl\|Matches\|spec" | head -20

# Public endpoint audit (Bugs #251 + #252) — controllers БЕЗ @UseGuards(JwtAuthGuard)
# Знайти контролери де клас НЕ декорований JwtAuthGuard
for c in $(find apps/api/src/modules -name "*.controller.ts" -not -name "*.spec.*"); do
  if ! grep -q "@UseGuards(JwtAuthGuard\|@UseGuards.*JwtAuthGuard" "$c"; then
    # перевірити що в файлі є хоча б один handler без guard
    grep -q "@Get\|@Post\|@Patch\|@Delete\|@Sse" "$c" && echo "PUBLIC CTRL: $c"
  fi
done
# Public-DTO double-strict audit: для кожного PUBLIC controller вивести його DTO file
# і grep-нути на @IsArray БЕЗ @ArrayMaxSize у попередніх 3 рядках, та array UUID-поля
# у service.create без tenant-FK count.
```

- [ ] User-supplied URL що server fetch-ить → `validatePublicUrl()` (`apps/api/src/common/utils/url-guard.ts`)
- [ ] `fetch(userUrl)` → `{ redirect: 'manual' }` + перевірка 3xx → block
- [ ] Paired SSRF defense (Bug #273) — `T1.4-001`
- [ ] `@IsArray()` → `@ArrayMaxSize(N)` (N = реалістичний бізнес-ліміт)
- [ ] Вільний `@IsString()` → `@MaxLength(N)` (anti-DoS)
- [ ] `@IsIn(['A','B','C'])` для union-string типів (`'OK' | 'WARN' | 'CRITICAL'`)
- [ ] Public endpoint double-strict audit; там само: виклик external service (SMS, ПРРО) → черга з attempts ≥ 10 + exponential backoff (Bugs #251 + #252) — `T1.4-002`
- [ ] Secret at-rest via Prisma `$extends` (Bug #652) — `T1.4-003`
- [ ] «Порожня адреса ≡ типова» у перевірці (`sameApiUrl`, `if (url && …)`), а вибір адреси — через `??`: `"" ?? fallback` дає `""`, і провайдер іде на свою типову адресу повз перевірку (Bug #955). `grep -rn "apiUrl ?? " apps/api/src/modules` поруч із `sameApiUrl`/`apiUrl &&`
- [ ] Аудит/лог з `{ ...dto }` моделі, що має поля з `ENCRYPTED_FIELDS`: write-only секрет лягає відкрито в `audit_events.diff` і віддається `GET /audit` ролям, що самого секрету не бачать (Bug #951). Grep: `grep -rn "audit.*{ ...dto }" apps/api/src/modules` → поля моделі проти `ENCRYPTED_FIELDS`; fix — маска `***`, `null` лишити
- [ ] Знятий `@SkipThrottle()` (або посилений `@Throttle`) на auth-роуті, який клієнт шле БЕЗ дедупу → 429 → примусовий logout (Bug #965). Коли бек додає ліміт на `/auth/refresh` (чи login/logout), перевір клієнтський виклик: `grep -n "tryRefresh\|/auth/refresh" apps/web/src/lib/api-client.ts` — скільки місць його кличуть і чи є спільний in-flight promise. Сплеск паралельних 401 (кілька TanStack-запитів перезапускаються після протермінування токена) без дедупу шле N одночасних POST → перевищує щойно доданий ліміт → 429 → `clearToken()` + redirect `/login`. Grep-сигнал: `git diff <base> -- apps/api/src | grep -E "SkipThrottle|@Throttle"` і в тому ж блоці немає зміни в `api-client.ts`. Fix — module-level single in-flight promise (дзеркало GET-dedup). Severity HIGH
- [ ] Клієнт гасить сесію на 429 так само, як на 401 — logout щойно залогіненого (Bug #966). Доповнення до #965: дедуп прибирає сплеск, але не гарантує <ліміт (кілька навігацій/воркерів/довга сесія). ПЕРЕВІР РЕАКЦІЮ НА СТАТУС, не лише fan-out: 401=сесія мертва (вийти), 429/5xx=тимчасово (сесія ЖИВА, токен ще валідний). `grep -rn "if (!res.ok)\|clearToken\|LOGOUT\|replace('/login')" apps/web/src/lib/api-client.ts apps/web/src/lib/auth/context.tsx` — якщо 429 падає в ту саму гілку, що 401 → фоновий refresh 429 кидає валідну сесію на /login. Порахуй ВСІ refresh-flow: `api-client` (3 обробники) + `AuthProvider` mount (`context.tsx refreshToken`) + mobile — дедуп api-client НЕ покриває mount-flow. Fix: на 429 зберегти сесію якщо є токен+кеш employee (повернути true / кинути тимчасову помилку), вихід лише на 401. Відтворення: curl-ом вичерпати bucket (N+1), тоді форм-логін+навігація — не має бути bounce. Тест мутаційний (429→employee лишається; контроль 401→LOGOUT). E2E: ad-hoc форм-логін мусить ставити `sto_e2e_skip_refresh` (дзеркало `setup-auth.ts`). Severity HIGH

---
