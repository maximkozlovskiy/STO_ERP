#!/usr/bin/env python
"""Гейт: у файлах репо немає подвійно закодованого UTF-8 («мойібаке»).

НАВІЩО. 2026-10-18 у DTO api знайшлись «0вЂ“23», «в†’», «в”Ђв”Ђ» і `в‚ґ` замість «–», «→», «─» і «₴»:
UTF-8 колись прочитали як cp1251 і зберегли знову. Зіпсовані описи йшли в Swagger, `openapi.json` і
`api-types.ts`, і ніхто не помічав місяцями — у редакторі це «просто дивні символи».

ЩО ЛОВИТЬ. Лише надійні ознаки: «в» + символ, яким у cp1251 стає другий байт трибайтового UTF-8
(Ђ, †, ”) і ланцюжок `в‚ґ` (₴). Двосимвольні збіги на кшталт «Рі» чи «СІ» не ловить — це звичайні
слова («Рішення»), і гейт давав би хибні падіння.

    python scripts/check-mojibake.py              # exit 0 — чисто, 1 — знайдено
    python scripts/check-mojibake.py --self-test
"""
import os
import re
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# «В§» перед цифрою — двобайтовий «§» (C2 A7) у cp1251: так зіпсувалось «§2.3» у work-orders.dto
# (2026-10-18, пропущене першим проходом). Звичайне «В §5» має пробіл і не ловиться.
MARK = re.compile(r"в(?:[Ђ†”][^\x00-\x7FА-Яа-яЄєІіЇїҐґ]?|‚ґ)|В§\d")
SKIP_EXT = (".png", ".jpg", ".jpeg", ".ico", ".gif", ".webp", ".woff", ".woff2", ".pdf", ".zip",
            ".gz", ".xlsx", ".traineddata", ".exe", ".dll")
# Файли, що навмисно МІСТЯТЬ приклади мойібаке (опис самої проблеми).
ALLOW = {"scripts/check-mojibake.py"}


def tracked_files():
    out = subprocess.run(["git", "-C", ROOT, "ls-files"], capture_output=True, text=True,
                         encoding="utf-8").stdout
    return [f for f in out.split("\n") if f and not f.endswith(SKIP_EXT) and "pnpm-lock" not in f]


def scan(text):
    return [m.group(0) for m in MARK.finditer(text)]


def self_test():
    cases = [
        ("Година (0вЂ“23)", 1),
        ("`uah` в†’ `UAH`", 1),
        ("// в”Ђв”Ђв”Ђ Vehicle", 1),
        ("example: 'в‚ґ'", 1),
        ("// В§2.3 Input validation", 1),
        ("В §5 правил, §2.3", 0),
        ("Рішення власника, СІМ, обов’язково, «в» кінці", 0),
        ("Година (0–23) → ₴ — ───", 0),
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
    found = []
    files = tracked_files()
    for f in files:
        if f in ALLOW:
            continue
        try:
            text = open(os.path.join(ROOT, f), "rb").read().decode("utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for i, line in enumerate(text.split("\n"), 1):
            if MARK.search(line):
                found.append(f"{f}:{i}: {line.strip()[:120]}")
    if found:
        print("❌ mojibake: подвійно закодований UTF-8 (прочитаний як cp1251) —")
        for x in found[:30]:
            print(f"   • {x}")
        print("   Відновити: s.encode('cp1251').decode('utf-8') для зіпсованого фрагмента.")
        print(f"{len(found)} failed ({len(found)})")
        return 1
    print(f"✅ mojibake: {len(files)} файлів без подвійно закодованого UTF-8")
    print(f"{len(files)} passed ({len(files)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
