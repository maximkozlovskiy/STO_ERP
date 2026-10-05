#!/usr/bin/env python
"""Перетворює vitest JSON-звіт у СТАБІЛЬНИЙ baseline для гейта «нічого не втрачено».

НАВІЩО НЕ СИРИЙ ЗВІТ. `vitest run --reporter=json` дає 1.35 МБ, з них більшість —
летючі поля: `duration`, `startTime`/`endTime`, `benchmarks`, `meta`. У git такий файл
створював би diff на кожен прогін, і сенс «змінився baseline → подивись чому» зникав би.

ЩО ЛИШАЄТЬСЯ. Лише те, що мусить бути стабільним між прогонами:
  файл -> відсортований список `fullName` кейсів.
Кількість не зберігається окремо: вона = len(списку). Зберігати і те, і те означало б
два джерела правди, які можуть розійтись.

ЧОМУ `fullName`, А НЕ `title`. `fullName` містить ланцюг describe-ів, тож порівняння
МНОЖИН ловить не лише зниклий `it`, а й зниклий/перейменований `describe` — тобто саме
те, що ламається при розбитті монолітів.

ЧОМУ НЕ `vitest list`. Він статично парсить AST і зараховує сторонні виклики: на
supplier-returns.service.spec.ts дав 31 «тест» замість 26 (серед них літерал
`{ providers: [...] }` із Test.createTestingModule). Джерело — лише раннер.

ВИКОРИСТАННЯ
  python scripts/spec-baseline.py <report.json> --out apps/api/test-baseline.json
"""
import io
import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def rel(path):
    """Шлях від кореня репо з прямими слешами — щоб baseline не залежав від ОС."""
    p = os.path.relpath(os.path.abspath(path), REPO)
    return p.replace(os.sep, "/")


def distil(report):
    out = {}
    for f in report.get("testResults", []):
        names = sorted(a["fullName"] for a in f.get("assertionResults", []))
        out[rel(f["name"])] = names
    return out


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    src = sys.argv[1]
    out = "apps/api/test-baseline.json"
    if "--out" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1]

    report = json.load(io.open(src, encoding="utf-8"))
    if report.get("numFailedTests"):
        print("ВІДМОВА: у звіті %d падінь — baseline знімається лише з зеленого прогону."
              % report["numFailedTests"])
        return 1

    files = distil(report)
    total = sum(len(v) for v in files.values())
    if total != report.get("numTotalTests"):
        print("ВІДМОВА: сума кейсів %d != numTotalTests %d" % (total, report["numTotalTests"]))
        return 1

    payload = {
        "_comment": "Згенеровано scripts/spec-baseline.py з vitest JSON-звіту. "
                    "Руками не правити: оновлювати тим самим скриптом, щоб diff показував "
                    "РІВНО ті кейси, що додались або зникли.",
        "files": files,
    }
    io.open(out, "w", encoding="utf-8", newline="\n").write(
        json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
    )
    print("baseline: %d файлів, %d кейсів -> %s" % (len(files), total, out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
