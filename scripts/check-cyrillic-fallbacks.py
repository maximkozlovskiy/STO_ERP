#!/usr/bin/env python
"""Гейт: у спільному коді web немає кириличних запасних текстів поза i18n.

НАВІЩО. Спільні компоненти й хуки (`components/ui`, `hooks`, `lib`) показують текст на кожній
сторінці. Запасний текст українською — `?? 'Помилка'`, `t('key', 'Зберегти')`, типовий проп
`placeholder = 'Пошук…'` — в англійському інтерфейсі лишається українським: ключа немає, і ніхто
цього не помічає. Виправлялись по одному (#911 і далі, TECH-DEBT §15 п. 2); аудит 2026-10-23 знайшов
13 місць у цих трьох теках. Гейт тримає нуль.

ЩО ЛОВИТЬ (рядок із кириличною літерою в лапках):
  · `?? 'Кирилиця'`, `|| 'Кирилиця'` — запасне значення виразу;
  · `t('ключ', 'Кирилиця')` — типове значення перекладу;
  · `ім'я = 'Кирилиця'` у параметрах / деструктуризації (типовий проп), але НЕ `const x = '…'`.
Коментарі (`//`, `*`) не перевіряються. Тести (`__tests__`, `*.test.*`) поза гейтом.

    python scripts/check-cyrillic-fallbacks.py              # exit 0 — чисто, 1 — знайдено
    python scripts/check-cyrillic-fallbacks.py --self-test
"""
import os
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "apps", "web", "src")
SCOPES = ("components/ui", "hooks", "lib")

CYR = "Ѐ-ӿ"
# Рядковий літерал із кириличною літерою (одинарні, подвійні чи зворотні лапки, в одному рядку).
LIT = r"(?:'[^'\n]*[%s][^'\n]*'|\"[^\"\n]*[%s][^\"\n]*\"|`[^`\n]*[%s][^`\n]*`)" % (CYR, CYR, CYR)
RULES = [
    ("запасне значення ?? / ||", re.compile(r"(?:\?\?|\|\|)\s*" + LIT)),
    ("типове значення t()", re.compile(r"\bt\(\s*['\"`][^'\"`\n]+['\"`]\s*,\s*" + LIT)),
    # Типовий проп / параметр: `name = 'Кирилиця'` перед `,` `)` `}` або в кінці рядка, де
    # ліворуч немає const / let / var і це не порівняння.
    ("типовий проп", re.compile(r"(?<![=!<>\w.])\b[A-Za-z_]\w*\s*=(?!=)\s*" + LIT + r"\s*(?=[,)}]|$)")),
]
DECL = re.compile(r"^\s*(?:export\s+)?(?:const|let|var|readonly|private|public|protected|static)\b")


def code_part(line):
    """Рядок без коментаря `// …` (поза лапками) і без рядків JSDoc / блочних коментарів."""
    stripped = line.lstrip()
    if stripped.startswith(("*", "/*", "//")):
        return ""
    out, quote, i = [], None, 0
    while i < len(line):
        ch = line[i]
        if quote:
            if ch == "\\":
                out.append(line[i:i + 2])
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "'\"`":
            quote = ch
        elif line.startswith("//", i):
            break
        out.append(ch)
        i += 1
    return "".join(out)


def scan(text):
    found = []
    for n, raw in enumerate(text.split("\n"), 1):
        line = code_part(raw)
        if not line or not re.search("[%s]" % CYR, line):
            continue
        for name, rule in RULES:
            if name == "типовий проп" and DECL.match(line):
                continue
            if rule.search(line):
                found.append((n, name, raw.strip()))
                break
    return found


def files():
    for scope in SCOPES:
        for dirpath, dirnames, filenames in os.walk(os.path.join(WEB, scope)):
            dirnames[:] = [d for d in dirnames if d not in ("__tests__", "node_modules")]
            for f in filenames:
                if f.endswith((".ts", ".tsx")) and ".test." not in f and ".spec." not in f:
                    yield os.path.join(dirpath, f)


def self_test():
    cases = [
        ("const msg = e?.message ?? 'Помилка';", 1),
        ("setError(e instanceof Error ? e.message : x || \"Не вдалося\");", 1),
        ("label={t('common.save', 'Зберегти')}", 1),
        ("  placeholder = 'Пошук…',", 1),
        ("export function EmptyState({ title = 'Немає даних' }: Props) {", 1),
        ("function f(a: string, b = `Кирилиця`) {", 1),
        ("const LABEL = 'Кирилиця';", 0),
        ("  readonly name = 'Кирилиця';", 0),
        ("if (status === 'Чернетка') return;", 0),
        ("// fallback ?? 'Помилка' — колись тут був", 0),
        (" * @example title = 'Немає даних'", 0),
        ("const msg = e?.message ?? t('common:error');", 0),
        ("placeholder = t('search.placeholder'),", 0),
        ("const url = base ?? '/api'; // ?? 'Помилка' у коментарі", 0),
        ("label={t('common.save')}", 0),
    ]
    bad = [(t, w, len(scan(t))) for t, w in cases if (len(scan(t)) > 0) != (w > 0)]
    for t, w, got in bad:
        print(f"FAIL self-test: {t!r} очікувано {w}, знайдено {got}")
    n = len(cases)
    print(f"{n - len(bad)} passed ({n})" if not bad else f"{len(bad)} failed ({n})")
    return 1 if bad else 0


def main():
    if "--self-test" in sys.argv:
        return self_test()
    found, count = [], 0
    for path in files():
        count += 1
        try:
            text = open(path, encoding="utf-8").read()
        except (UnicodeDecodeError, OSError):
            continue
        rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
        found += [f"{rel}:{n}: [{kind}] {line[:110]}" for n, kind, line in scan(text)]
    if found:
        print("❌ кириличні запасні тексти поза i18n (apps/web/src: " + ", ".join(SCOPES) + ") —")
        for x in found:
            print(f"   • {x}")
        print("   Текст — у каталог i18n (locales/uk|en), у коді — t('ns:key') без типового значення.")
        print(f"{len(found)} failed ({len(found)})")
        return 1
    print(f"✅ кириличні запасні тексти: {count} файлів " + ", ".join(SCOPES) + " без них")
    print(f"{count} passed ({count})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
