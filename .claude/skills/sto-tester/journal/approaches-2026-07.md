# sto-tester — журнал підходів, 2026-07

> Не читати цілком — шукати за ключовим словом.

### 2026-07-03 — Sprint-wide DTO drift detection: canonical-pattern context grep (Bug #587) — api / dto / anti-dos / drift

**Сигнал:** 30+ файлів `@IsArray()`+`@ArrayMaxSize(N)`, ~5 пропустили cap. TS/unit green, review не ловить (grep-scan не використаний).

```bash
for line in $(grep -rn "<PRIMARY_MARKER>" <SCOPE> --include="*.<EXT>" | cut -d: -f1-2); do
  file=$(echo "$line" | cut -d: -f1); ln=$(echo "$line" | cut -d: -f2)
  ctx=$(sed -n "$((ln-5)),$((ln+5))p" "$file")
  echo "$ctx" | grep -qE "<PAIRED_MARKER_REGEX>" || echo "MISSING: $file:$ln"
done
# фільтр false-positive: awk 'NR<=LN && /^export class.*Dto/{c=$0} END{print c}' | grep -qE "Response|Paginated|Public|List" && continue
```

Приклади: `@IsArray()` без `@ArrayMaxSize|@ArrayMinSize`; `@IsString()` без `@MaxLength|@IsIn|@IsEmail|@IsUrl|@Matches|@IsUUID`; `@IsUUID()` без `Transform`; `?:number` без `@IsInt|@IsNumber|@Min|@Max|@Type` (#283); `$transaction(async` без `timeout:`.
**Фікс:** batch — small→20, medium→100, list→200; inner `@IsString()`→`@MaxLength(N,{each:true})`.
**Severity:** MEDIUM (auth-protected insider), systematic-consistency→release-blocker.
