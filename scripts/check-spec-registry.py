#!/usr/bin/env python
"""Три гейти спец-орієнтованих тестів: втрата кейсів, нові моноліти, цілісність дос'є.

КОНТЕКСТ. 2026-10-05 розбиття `purchase-orders.service.spec.ts` (1960 рядків) на 7 файлів
за аспектами знищило наявний `purchase-orders.contract.spec.ts` (593 рядки): згенерований
slug `contract` збігся з іменем, яке вже існувало. Втрату зловила НЕ перевірка, а
арифметика — 47+101 != 182. Цей скрипт робить такий контроль механічним.

ГЕЙТ A — ВТРАТА КЕЙСІВ (ядро).
Порівнює фактичний vitest-звіт із `apps/api/test-baseline.json` ПО МНОЖИНАХ `fullName`,
а не по сумах: «182 -> 182» не виключає «втратив один кейс і продублював інший».
Зниклий кейс -> блок. Новий кейс -> блок із підказкою оновити baseline (щоб у diff
було видно РІВНО те, що додалось).

ГЕЙТ B — НОВІ МОНОЛІТИ.
Файл довший за поріг І з >=2 top-level `describe`. Дві умови разом свідомо: довгий файл з
ОДНИМ describe не має шва, по якому його ріжуть, — це велика тема, а не моноліт.

ГЕЙТ C — ЦІЛІСНІСТЬ ДОС'Є.
Файли, названі у реєстрах `docs/objects/*.md`, мусять існувати. `check-doc-links.py` цього
не ловить за конструкцією: він перевіряє лише `.md`-цілі (так у його докстрингу й написано).

ЧОМУ НЕ `vitest list` ЯК ДЖЕРЕЛО ФАКТУ. Він статично парсить AST і зараховує сторонні
виклики: на supplier-returns дав 31 замість 26. Джерело факту — лише раннер.

ВИКОРИСТАННЯ
  python scripts/check-spec-registry.py                      # усі гейти (A — SKIPPED без звіту)
  python scripts/check-spec-registry.py --from-report r.json  # з готовим звітом (CI)
  python scripts/check-spec-registry.py --gate-size           # лише B
  python scripts/check-spec-registry.py --gate-registry       # лише C
"""
import glob
import io
import json
import os
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASELINE = os.path.join(REPO, "apps", "api", "test-baseline.json")
SIZE_LIMIT = 900

# Маркер у файлі, що великий розмір свідомий. Причина живе ПОРУЧ з кодом, а не у
# списку винятків, який ніхто не перечитує.
OK_MARKER = re.compile(r"spec-monolith-ok:")
# `describe(` і його варіанти. Без `.skip`/`.each`/`.only` гейт МОВЧАВ на файлі у
# 1007 рядків із двома такими блоками (перевірено пробою 2026-10-07): моноліт із
# `describe.each` проходив би непоміченим.
TOP_DESCRIBE = re.compile(r"^describe(?:\.(?:skip|only|each|concurrent|sequential))?[(.]", re.M)
# Рядок реєстру: | аспект | `файл.spec.ts` | кейсів | ...
REG_ROW = re.compile(r"^\|[^|]*\|\s*`([^`]+\.spec\.ts)`\s*\|", re.M)
REG_MODULE = re.compile(r"^\*\*Модуль:\*\*\s*(.+)$", re.M)


def rel(path):
    return os.path.relpath(os.path.abspath(path), REPO).replace(os.sep, "/")


def load_baseline():
    if not os.path.exists(BASELINE):
        return None
    return json.load(io.open(BASELINE, encoding="utf-8")).get("files", {})


def gate_a(report_path, problems):
    """Втрата/поява кейсів проти baseline. Повертає кількість перевірених файлів."""
    base = load_baseline()
    if base is None:
        print("  ГЕЙТ A: SKIPPED — немає apps/api/test-baseline.json")
        return 0
    if not report_path:
        print("  ГЕЙТ A: SKIPPED — звіт не переданий (--from-report). Невідоме != чисто.")
        return 0
    rep = json.load(io.open(report_path, encoding="utf-8"))
    fact = {}
    for f in rep.get("testResults", []):
        fact[rel(f["name"])] = {a["fullName"] for a in f.get("assertionResults", [])}

    # Файли, що є у baseline, але відсутні у звіті, перевіряємо лише коли звіт ПОВНИЙ:
    # частковий прогін (один модуль) законно не містить решти.
    full_run = len(fact) >= len(base)
    checked = 0
    for path, names in sorted(base.items()):
        got = fact.get(path)
        if got is None:
            if full_run:
                problems.append("ЗНИК ФАЙЛ %s (%d кейсів у baseline)" % (path, len(names)))
            continue
        checked += 1
        expected = set(names)
        lost = expected - got
        added = got - expected
        for n in sorted(lost)[:5]:
            problems.append("ЗНИК КЕЙС %s :: %s" % (path, n[:90]))
        for n in sorted(added)[:5]:
            problems.append("НОВИЙ КЕЙС (онови baseline) %s :: %s" % (path, n[:90]))
    for path in sorted(set(fact) - set(base)):
        problems.append("ФАЙЛ ПОЗА BASELINE (онови baseline) %s" % path)
    if rep.get("numFailedTests"):
        problems.append("%d тестів падають — вердикт неможливий" % rep["numFailedTests"])
    return checked


def gate_b(problems):
    """Нові моноліти: довгий файл + >=2 top-level describe."""
    found = 0
    for path in sorted(glob.glob(os.path.join(REPO, "apps", "*", "src", "**", "*.spec.ts"),
                                 recursive=True)):
        src = io.open(path, encoding="utf-8", errors="replace").read()
        n = src.count("\n")
        if n <= SIZE_LIMIT:
            continue
        if OK_MARKER.search(src):
            continue
        if len(TOP_DESCRIBE.findall(src)) < 2:
            continue
        found += 1
        problems.append("МОНОЛІТ %s — %d рядків, %d top-level describe"
                        % (rel(path), n, len(TOP_DESCRIBE.findall(src))))
    return found


def gate_c(problems):
    """Файли, названі у реєстрах дос'є, існують."""
    checked = 0
    for doc in sorted(glob.glob(os.path.join(REPO, "docs", "objects", "*.md"))):
        if "_TEMPLATE" in doc:
            continue
        src = io.open(doc, encoding="utf-8", errors="replace").read()
        rows = REG_ROW.findall(src)
        if not rows:
            continue
        mods = REG_MODULE.search(src)
        if not mods:
            problems.append("РЕЄСТР БЕЗ **Модуль:** %s — не знаю, де шукати %d файлів"
                            % (rel(doc), len(rows)))
            continue
        bases = [m.strip().strip("`") for m in mods.group(1).split(",")]
        for fname in rows:
            checked += 1
            if any(os.path.isfile(os.path.join(REPO, b, fname)) for b in bases):
                continue
            # дозволяємо шлях із підтекою, записаний у самому рядку
            if any(os.path.isfile(os.path.join(REPO, b, *fname.split("/"))) for b in bases):
                continue
            problems.append("НЕМА ФАЙЛУ з реєстру %s -> %s (база: %s)"
                            % (rel(doc), fname, ", ".join(bases)))
    return checked


def main():
    only_size = "--gate-size" in sys.argv
    only_reg = "--gate-registry" in sys.argv
    report = None
    if "--from-report" in sys.argv:
        report = sys.argv[sys.argv.index("--from-report") + 1]

    problems, checked = [], 0
    run_all = not (only_size or only_reg)
    if run_all:
        checked += gate_a(report, problems)
    if run_all or only_size:
        checked += gate_b(problems)
    if run_all or only_reg:
        checked += gate_c(problems)

    for p in problems:
        print("  %s" % p)
    print()
    if problems:
        print("%d failed | %d passed (%d)" % (len(problems), checked, checked + len(problems)))
        return 1
    print("%d passed (%d)" % (checked, checked))
    return 0


if __name__ == "__main__":
    sys.exit(main())
