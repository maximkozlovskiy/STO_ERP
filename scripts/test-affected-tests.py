#!/usr/bin/env python
"""Тест селектора scripts/affected-tests.py. Запуск: python scripts/test-affected-tests.py

НАВІЩО. Селектор вирішує, які тести НЕ запускати. Помилка в ньому не дає червоного тесту —
вона дає зелений прогін, у якому потрібний тест просто не стартував. Таку помилку видно
лише перевіркою самого вибору, тому кожен кейс нижче — реальний файл репозиторію і те,
що для нього мусить (або не мусить) бути обрано.

Селектор ганяється окремим процесом із `--json`, як його кличуть агенти.
"""
import json
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SELECTOR = os.path.join(ROOT, "scripts", "affected-tests.py")

CROSS = "console-errors.spec.ts"  # представник наскрізних E2E


def run(*files):
    proc = subprocess.run(
        [sys.executable, SELECTOR, "--json"] + list(files),
        cwd=ROOT,
        capture_output=True,
    )
    assert proc.returncode == 0, proc.stderr.decode("utf-8", errors="replace")
    return json.loads(proc.stdout.decode("utf-8"))


CASES = []


def case(title):
    def wrap(fn):
        CASES.append((title, fn))
        return fn

    return wrap


@case("api-модуль з однойменною сторінкою → його E2E, без повного прогону")
def _():
    r = run("apps/api/src/modules/invoices/invoices.service.ts")
    assert not r["full"] and not r["e2e_full"], r["reasons"]
    assert "invoices.spec.ts" in r["e2e"] and "crud-invoice.spec.ts" in r["e2e"], r["e2e"]
    assert "payroll.spec.ts" not in r["e2e"], "вибір не локальний"


@case("api-модуль → усі спеки його теки потрапляють у команду API")
def _():
    r = run("apps/api/src/modules/invoices/invoices.service.ts")
    assert "apps/api/src/modules/invoices/invoices.service.ts" in r["api"]
    assert "apps/api/src/modules/invoices/invoices.due-date.spec.ts" in r["api"], r["api"]
    assert not r["web"]


@case("зміна лише api → наскрізні E2E не додаються")
def _():
    r = run("apps/api/src/modules/invoices/invoices.service.ts")
    assert CROSS not in r["e2e"], r["e2e"]


@case("спільний пакет → повний прогін")
def _():
    r = run("packages/shared/src/types.ts")
    assert r["full"] and r["e2e_full"], r


@case("apps/api/src/common → повний прогін")
def _():
    r = run("apps/api/src/common/utils/array.ts")
    assert r["full"], r


@case("тест у спільній теці → лише він сам, без повного прогону")
def _():
    f = "apps/api/src/prisma/field-encryption.integration.spec.ts"
    r = run(f)
    assert not r["full"], r["reasons"]
    assert r["api"] == [f], r["api"]


@case("конфіг раннера → повний прогін")
def _():
    assert run("apps/web/playwright.config.ts")["full"]
    assert run("apps/api/vitest.config.ts")["full"]


@case("компонент, який імпортує оболонка всіх сторінок → весь E2E, але unit локально")
def _():
    r = run("apps/web/src/components/ui/date-picker-input.tsx")
    assert r["e2e_full"] and not r["full"], r
    assert r["web"] == ["apps/web/src/components/ui/date-picker-input.tsx"]


@case("сторінка маршруту → лише її E2E + наскрізні")
def _():
    r = run("apps/web/src/app/(app)/payroll/page.tsx")
    assert not r["e2e_full"], r["reasons"]
    assert "payroll.spec.ts" in r["e2e"] and CROSS in r["e2e"], r["e2e"]
    assert "invoices.spec.ts" not in r["e2e"], "вибір не локальний"


@case("модалка одного агрегату → E2E лише його маршруту")
def _():
    r = run("apps/web/src/components/ui/InvoiceCreateModal.tsx")
    assert not r["e2e_full"], r["reasons"]
    assert r["routes"] == ["invoices"], r["routes"]


@case("**Маршрути UI:** у дос'є перевизначає маршрут api-модуля")
def _():
    r = run("apps/api/src/modules/goods/goods.service.ts")
    assert "catalog" in r["routes"] and "inventory" in r["routes"], r["routes"]
    assert "crud-catalog.spec.ts" in r["e2e"], r["e2e"]
    assert not r["e2e_undetermined"]


@case("api-модуль без однойменної сторінки → маршрут через URL контролера")
def _():
    r = run("apps/api/src/modules/comments/comments.service.ts")
    assert r["routes"] == ["work-orders"], r
    assert "work-orders.spec.ts" in r["e2e"]


@case("api-модуль, до якого web не звертається → «не визначено», а не тиша")
def _():
    r = run("apps/api/src/modules/pdf/pdf.service.ts")
    assert r["e2e_undetermined"] == ["pdf"], r


@case("змінений E2E-спек → запускається він сам")
def _():
    r = run("apps/web/e2e/payroll.spec.ts")
    assert r["e2e"] == ["payroll.spec.ts"], r["e2e"]
    assert not r["api"] and not r["web"]


@case("спільна обв'язка E2E (fixtures, setup-auth) → повний прогін")
def _():
    assert run("apps/web/e2e/fixtures.ts")["full"]


@case("лише документація → нічого не запускати")
def _():
    r = run("docs/PROCESS.md", "CHANGELOG.md")
    assert not (r["api"] or r["web"] or r["e2e"] or r["full"] or r["e2e_full"]), r


@case("видалений файл не потрапляє в команду (vitest впав би на відсутньому шляху)")
def _():
    r = run("apps/api/src/modules/invoices/zzz-deleted.service.ts")
    assert "apps/api/src/modules/invoices/zzz-deleted.service.ts" not in r["api"]
    assert "apps/api/src/modules/invoices/invoices.due-date.spec.ts" in r["api"]


@case("кожен E2E-спек досяжний: або наскрізний, або відвідує наявний маршрут")
def _():
    import importlib.util

    spec = importlib.util.spec_from_file_location("affected", SELECTOR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    routes = mod.app_routes()
    orphans = [
        s for s, rs in mod.spec_routes().items() if s not in mod.CROSS_E2E and not (rs & routes)
    ]
    assert not orphans, "спеки, які селектор ніколи не вибере: %s" % orphans


@case("граф імпортів web розв'язаний повністю (нерозв'язане = сліпа зона)")
def _():
    import importlib.util

    spec = importlib.util.spec_from_file_location("affected", SELECTOR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _, unresolved = mod.web_reverse_graph()
    assert not unresolved, unresolved[:5]


def main():
    failed = 0
    for title, fn in CASES:
        try:
            fn()
        except AssertionError as exc:
            failed += 1
            print("  ✗ %s%s    %s" % (title, chr(10), str(exc)[:300]))
    total = len(CASES)
    print()
    if failed:
        print("%d failed | %d passed (%d)" % (failed, total - failed, total))
        return 1
    print("%d passed (%d)" % (total, total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
