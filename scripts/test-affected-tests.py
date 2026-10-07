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


def run_raw(*args, cwd=ROOT):
    return subprocess.run([sys.executable, SELECTOR] + list(args), cwd=cwd, capture_output=True)


def run(*files):
    proc = run_raw("--json", *files)
    assert proc.returncode == 0, proc.stderr.decode("utf-8", errors="replace")
    return json.loads(proc.stdout.decode("utf-8"))


def load():
    import importlib.util

    spec = importlib.util.spec_from_file_location("affected", SELECTOR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


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
    assert "crud-employee.spec.ts" not in r["e2e"], "вибір не локальний"


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


@case("**Маршрути UI:** у дос'є задає маршрут api-модуля без однойменної сторінки")
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
    r = run("apps/api/src/modules/reconciliation/reconciliation.processor.ts")
    assert r["e2e_undetermined"] == ["reconciliation"], r


# ── хибна локальність: зміни, для яких «лише своє» означало б пропущений тест ──────────


@case("api-модуль з однойменною сторінкою → ще й сторінки, що звертаються до його URL")
def _():
    # Рахунок створюють із наряду: /work-orders кличе /invoices, і його E2E мусить піти.
    r = run("apps/api/src/modules/invoices/invoices.service.ts")
    assert "work-orders" in r["routes"], r["routes"]
    # Публічна сторінка /booking однойменна з модулем, але UI персоналу живе на /bookings.
    r = run("apps/api/src/modules/booking/booking.service.ts")
    assert "bookings.spec.ts" in r["e2e"] and "crud-booking.spec.ts" in r["e2e"], r["e2e"]


@case("сервіс, який інжектять інші модулі → E2E і їхніх сторінок")
def _():
    r = run("apps/api/src/modules/inventory/inventory.service.ts")
    for route in ("inventory", "work-orders", "stock-documents", "purchase-orders"):
        assert route in r["routes"], (route, r["routes"])
    # Модуль без контролера і без сторінки: маршрути дають ті, хто його споживає.
    r = run("apps/api/src/modules/pdf/pdf.service.ts")
    assert "invoices" in r["routes"] and not r["e2e_undetermined"], r


@case("каркас api поза modules/ (main.ts, app.module.ts, health) → повний прогін")
def _():
    for f in ("main.ts", "app.module.ts", "health/health.controller.ts"):
        assert run("apps/api/src/" + f)["full"], f


@case("css, public/, .env, setup-файл vitest → не «нічого запускати»")
def _():
    assert run("apps/web/src/app/globals.css")["full"]
    assert run("apps/web/src/__tests__/setup.ts")["full"]
    assert run(".env.dev")["full"] and run("apps/web/.env.e2e")["full"]
    assert run("docker-compose.dev.yml")["full"]
    assert not run(".env.example")["full"]
    r = run("apps/web/public/sw.js")
    assert r["e2e_full"] and not r["full"], r


@case("файл, для якого тесту немає, названо у виводі, а не замовчано")
def _():
    r = run("docker-compose.yml", "installer/scripts/Setup-Stack.ps1", "docs/PROCESS.md")
    assert r["uncovered"] == ["docker-compose.yml", "installer/scripts/Setup-Stack.ps1"], r
    out = run_raw("docker-compose.yml").stdout.decode("utf-8")
    assert "ПОЗА СЕЛЕКТОРОМ" in out and "docker-compose.yml" in out, out


@case("скрипти з власними тестами → їхня команда у виводі")
def _():
    assert "python scripts/test-affected-tests.py" in run("scripts/affected-tests.py")["scripts"]
    gates = "python scripts/check-spec-registry.py --gate-size --gate-registry"
    assert gates in run("docs/objects/invoice.md")["scripts"]
    assert gates in run("apps/api/src/modules/invoices/invoices.due-date.spec.ts")["scripts"]


@case("помилка git або прапорця → exit 2, а не «0 змінених файлів»")
def _():
    for args in (["--base", "no-such-ref-zzz"], ["--base"], ["--bse", "HEAD"]):
        proc = run_raw(*args)
        out = proc.stdout.decode("utf-8")
        assert proc.returncode == 2, (args, proc.returncode, out)
        assert "Нічого запускати" not in out, out


@case("абсолютний шлях, ./шлях і шлях від іншої теки дають той самий вибір")
def _():
    rel = "apps/api/src/modules/invoices/invoices.service.ts"
    want = run(rel)["api"]
    assert want
    assert run(os.path.join(ROOT, *rel.split("/")))["api"] == want
    assert run("./" + rel)["api"] == want
    proc = run_raw("--json", "src/modules/invoices/invoices.service.ts", cwd=os.path.join(ROOT, "apps", "api"))
    assert json.loads(proc.stdout.decode("utf-8"))["api"] == want


@case("сторінка без власного E2E-спека → наскрізні спеки все одно йдуть")
def _():
    r = run("apps/web/src/app/booking/page.tsx")
    assert not r["e2e_full"], r["reasons"]
    assert CROSS in r["e2e"], r


@case("задовгий перелік файлів → порада ганяти весь набір, а не команда, що не стартує")
def _():
    mod = load()
    mod.MAX_ARGS_CHARS = 10
    res = mod.select(["apps/api/src/modules/invoices/invoices.service.ts"])
    api_line = [line for line in mod.render(res).split(chr(10)) if line.startswith("API")][0]
    assert res["api_all"] and "vitest run" in api_line and "related" not in api_line, api_line


@case("@Controller({ path: … }) розпізнається так само, як @Controller('…')")
def _():
    mod = load()
    found = mod.CONTROLLER_RE.findall(
        "@Controller({ path: 'public/work-orders', version: VERSION_NEUTRAL })"
        + chr(10)
        + "@Controller('invoices')"
    )
    assert found == ["public/work-orders", "invoices"], found


@case("нелітеральний import()/require() — сліпа зона графа, а не тиша")
def _():
    mod = load()
    bt = chr(96)
    for src in ("import(" + bt + "./x/${n}" + bt + ")", "import(path)", "require( /* c */ './a')"):
        assert mod.OPAQUE_IMPORT_RE.search(src), src
    for src in ("import('./a')", 'import("./a")', "typeof import('./a').T", "important(x)"):
        assert not mod.OPAQUE_IMPORT_RE.search(src), src
    assert mod.IMPORT_RE.findall("export * from './a'; const b = require('./b')") == ["./a", "./b"]


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


# ── знайдено мутаціями (2026-10-07): тест упав у повному прогоні, а у виборі його не було ──


@case("спек, що читає код з диска (статичний детектор) → у виборі для будь-якого файлу модуля")
def _():
    # `update({ where: { id } })` без orgId у сервісі валить саме цей спек, а сервіс він не
    # імпортує — читає його текст через readFileSync, тож `vitest related` його не приводить.
    static = "apps/api/src/prisma/tenant-guard-static.spec.ts"
    for f in ("vehicles/vehicles.service.ts", "invoices/invoice-overdue.processor.ts"):
        assert static in run("apps/api/src/modules/" + f)["api"], f
    # Зміна лише спека нічого в коді не міняє — сканер для неї не потрібен.
    r = run("apps/api/src/modules/vehicles/vehicles.service.spec.ts")
    assert static not in r["api"], r["api"]
    # Спек, що читає власний ТИМЧАСОВИЙ файл (mkdtemp), — не сканер коду.
    mod = load()
    tmp = "apps/api/src/modules/bank-statements/bank-statement-parser.service.spec.ts"
    assert tmp not in mod.scanning_specs(mod.API_SRC), mod.scanning_specs(mod.API_SRC)


@case("зміна скіла або гейта розміру → гейт розміру у виводі (а .claude/ більше ніщо не стереже)")
def _():
    cmd = "python scripts/check-skill-size.py"
    for f in (".claude/skills/sto-review/sections/web.md", "scripts/check-skill-size.py"):
        r = run(f)
        assert cmd in r["scripts"] and not r["uncovered"], (f, r)
    # Агент чи налаштування поза skills/ гейта не стосуються.
    assert cmd not in run(".claude/agents/sto-review-agent.md")["scripts"]


@case("пакет із власними тестами (packages/shared) → його команда у виводі повного прогону")
def _():
    # Плейсхолдер {{max}} → {{mx}} у messages.en.ts: api і web зелені, червоний лише
    # packages/shared/src/i18n/key-parity.spec.ts, якого в «API / WEB / E2E» немає.
    cmd = "cd packages/shared && npx vitest run"
    r = run("packages/shared/src/i18n/messages.en.ts")
    assert r["full"] and cmd in r["scripts"], r["scripts"]
    out = run_raw("packages/shared/src/i18n/messages.en.ts").stdout.decode("utf-8")
    assert "ІНШЕ: " + cmd in out, out
    # Пакет без тестів команди не отримує: вона впала б із «No test files found».
    assert not [c for c in run("packages/ui/src/index.ts")["scripts"] if "vitest" in c]


@case("**Маршрути UI:** доповнює виведене з коду, а не ховає сторінки, що кличуть API модуля")
def _():
    # Мутація: GET /counterparties віддає порожній список → 12 червоних спек-файлів, з них
    # у старому виборі (рівно маршрути з дос'є: /counterparties, /vehicles) був один.
    r = run("apps/api/src/modules/counterparties/counterparties.service.ts")
    assert not r["full"] and not r["e2e_full"], r["reasons"]
    assert "vehicles" in r["routes"], "маршрут із дос'є мусить лишитись"
    # сторінки, чий код звертається до /counterparties (вибір контрагента в документі)
    for spec in ("crud-invoice.spec.ts", "crud-purchase-order.spec.ts", "crud-calendar-slot.spec.ts"):
        assert spec in r["e2e"], (spec, r["e2e"])
    assert CROSS not in r["e2e"], "зміна лише api наскрізних не тягне"


@case("спек, який сам ходить в API модуля, у виборі — навіть якщо сторінка модуля не його")
def _():
    # work-orders-detail бере гараж через `/counterparties/${id}/garages`, а ходить лише на
    # /work-orders; vehicles — модуль без рядка в дос'є, тож це чисте ребро «спек → api».
    r = run("apps/api/src/modules/vehicles/vehicles.service.ts")
    assert "work-orders" not in r["routes"], r["routes"]
    assert "work-orders-detail.spec.ts" in r["e2e"], r["e2e"]
    mod = load()
    smap = mod.spec_routes()
    assert "client-payments.spec.ts" in mod.specs_calling("counterparties", smap)
    assert "a11y.spec.ts" not in mod.specs_calling("counterparties", smap), "наскрізні — окремо"
    assert mod.specs_calling("reconciliation", smap) == [], "модуль без контролера"


@case("зміна api, чию сторінку відвідує лише наскрізний спек → він у виборі, а не «E2E : —»")
def _():
    # /setup не має власного спека: його відвідують smoke і api-errors. Раніше для
    # setup.service.ts вибір був порожній, а примітка казала «маршрути без жодного E2E-спека».
    r = run("apps/api/src/modules/setup/setup.service.ts")
    assert "smoke.spec.ts" in r["e2e"] and "api-errors.spec.ts" in r["e2e"], r["e2e"]
    assert CROSS not in r["e2e"], "наскрізний спек, що /setup не відвідує, тут зайвий"
    assert not [n for n in r["notes"] if "без жодного E2E" in n], r["notes"]
    # Модуль із власною сторінкою і спеком наскрізних, як і раніше, не тягне.
    assert CROSS not in run("apps/api/src/modules/invoices/invoices.service.ts")["e2e"]


@case("кожен E2E-спек досяжний: або наскрізний, або відвідує наявний маршрут")
def _():
    mod = load()
    routes = mod.app_routes()
    orphans = [
        s for s, rs in mod.spec_routes().items() if s not in mod.CROSS_E2E and not (rs & routes)
    ]
    assert not orphans, "спеки, які селектор ніколи не вибере: %s" % orphans


@case("граф імпортів web розв'язаний повністю (нерозв'язане = сліпа зона)")
def _():
    mod = load()
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
