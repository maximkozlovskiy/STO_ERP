#!/usr/bin/env python
"""Тест scripts/agent-scopes.py. Запуск: python scripts/test-agent-scopes.py

НАВІЩО. Скрипт сфер — єдине, що не дає двом паралельним агентам писати в один файл і що
ловить агента, який вийшов за свою сферу. Якщо він помиляється в бік «усе гаразд», наслідок —
перемішані правки двох агентів в одному файлі, які ніхто не помітить. Тому кожен кейс —
реальні теки репозиторію і те, що для них мусить бути дозволено або заборонено.

`verify` перевіряється на тимчасовому плані з вигаданими шляхами: робоче дерево не чіпається.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "agent-scopes.py")


def run(*args):
    proc = subprocess.run([sys.executable, SCRIPT] + list(args), cwd=ROOT, capture_output=True)
    out = proc.stdout.decode("utf-8", errors="replace")
    return proc.returncode, out, proc.stderr.decode("utf-8", errors="replace")


def plan(*args):
    code, out, err = run("plan", *args)
    return code, json.loads(out), err


def load():
    spec = importlib.util.spec_from_file_location("agent_scopes", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CASES = []


def case(title):
    def wrap(fn):
        CASES.append((title, fn))
        return fn

    return wrap


@case("trace: сфера агрегату — лише його спеки, фікстури й дос'є; продукт-код поза сферою")
def _():
    code, p, _ = plan("--mode", "trace", "invoice")
    assert code == 0, p
    m = load()
    w = p["shards"][0]["write"]
    assert m.matches("apps/api/src/modules/invoices/invoices.due-date.spec.ts", w)
    assert m.matches("apps/api/src/modules/invoices/invoices.spec-fixture.ts", w)
    assert m.matches("docs/objects/invoice.md", w)
    assert not m.matches("apps/api/src/modules/invoices/invoices.service.ts", w), "продукт-код у trace"
    assert not m.matches("apps/api/src/modules/payments/payments.fiscal-gate.spec.ts", w), "чужий модуль"
    assert not m.matches("docs/objects/payments.md", w), "чуже дос'є"


@case("агрегат можна назвати і дос'є, і модулем — це той самий шард, не два")
def _():
    code, p, _ = plan("--mode", "trace", "invoice", "invoices")
    assert code == 0 and len(p["shards"]) == 1, [s["name"] for s in p["shards"]]


@case("сфери 12 агрегатів із правилами не перетинаються")
def _():
    names = [
        "invoice", "payments", "counterparty", "loyalty", "supplier-payment", "stock-document",
        "good", "work", "calendar", "maintenance-schedules", "purchase-order", "work-order",
    ]
    code, p, err = plan("--mode", "trace", *names)
    assert code == 0, err
    assert len(p["shards"]) == 12 and not p["overlaps"], p["overlaps"]


@case("сторінка, на яку претендують два агрегати, не дістається жодному (/catalog: good і work)")
def _():
    code, p, _ = plan("--mode", "impl", "good", "work")
    assert code == 0, p["overlaps"]
    for s in p["shards"]:
        assert not any("/catalog/" in w for w in s["write"]), (s["name"], s["write"])


@case("модуль без дос'є — сам собі агрегат і володіє однойменною сторінкою (employees)")
def _():
    code, p, _ = plan("--mode", "impl", "employees", "invoice")
    assert code == 0, p["overlaps"]
    by = {s["name"]: s["write"] for s in p["shards"]}
    assert any("modules/employees/" in w for w in by["employees"]), by
    assert any("(app)/employees/" in w for w in by["employees"]), by
    assert not any("employees" in w for w in by["invoice"]), by["invoice"]


@case("impl: модуль і власна сторінка цілком; чужа сторінка — ні")
def _():
    code, p, _ = plan("--mode", "impl", "invoice")
    m = load()
    w = p["shards"][0]["write"]
    assert m.matches("apps/api/src/modules/invoices/invoices.service.ts", w)
    assert m.matches("apps/web/src/app/(app)/invoices/page.tsx", w)
    assert not m.matches("apps/web/src/app/(app)/payments/page.tsx", w)


@case("перетин власних сфер (--scope) ловиться: exit 1 і названо обидві сторони")
def _():
    code, p, err = plan(
        "--mode", "impl",
        "--scope", "a=apps/api/src/modules/invoices/**",
        "--scope", "b=apps/api/src/modules/invoices/**/*.spec.ts",
    )
    assert code == 1 and p["overlaps"], (code, p["overlaps"])
    assert "ПЕРЕТИН СФЕР" in err and "failed" in err, err


@case("невідомий агрегат — помилка, а не порожній шард")
def _():
    code, p, err = plan("--mode", "trace", "no-such-aggregate-zzz")
    assert code == 1 and p["unknown"] == ["no-such-aggregate-zzz"], (code, p)


@case("qa: шукачі нічого не пишуть — сфера запису порожня, шард має перелік файлів")
def _():
    code, p, _ = plan("--mode", "qa", "--diff", "HEAD~30")
    assert all(s["write"] == [] for s in p["shards"]), [s["write"] for s in p["shards"]]
    assert all(s["files"] for s in p["shards"])


@case("diff: спільний код іде в наскрізний шард, а не до агрегату")
def _():
    m = load()
    aggs = m.aggregates()
    assert m.aggregate_of("apps/api/src/common/utils/array.ts", aggs) is None
    assert m.aggregate_of("packages/shared/src/types.ts", aggs) is None
    assert m.aggregate_of("apps/web/src/components/ui/modal.tsx", aggs) is None
    assert m.aggregate_of("apps/api/src/modules/invoices/invoices.service.ts", aggs) == "invoice"
    assert m.aggregate_of("apps/api/src/modules/comments/comments.service.ts", aggs) == "comments"


@case("невідома база для --diff — помилка, а не «нічого не змінено»")
def _():
    code, out, _ = run("plan", "--mode", "qa", "--diff", "deadbeefdeadbeef")
    assert code == 1 and "невідома база" in out, (code, out[:200])


@case("is_product: тест і фікстура — не продукт-код; сервіс, сторінка, схема — продукт")
def _():
    m = load()
    assert m.is_product("apps/api/src/modules/invoices/invoices.service.ts")
    assert m.is_product("apps/web/src/app/(app)/invoices/page.tsx")
    assert m.is_product("packages/database/prisma/schema/08_finance.prisma")
    assert not m.is_product("apps/api/src/modules/invoices/invoices.due-date.spec.ts")
    assert not m.is_product("apps/api/src/modules/invoices/invoices.spec-fixture.ts")
    assert not m.is_product("apps/web/src/components/ui/__tests__/Modal.test.tsx")
    assert not m.is_product("docs/objects/invoice.md")


@case("verify: файл поза сферами і продукт-код у trace блокують; файл у своїй сфері проходить")
def _():
    m = load()
    plan_obj = {
        "mode": "trace",
        "shards": [
            {"name": "a", "write": ["apps/api/src/modules/invoices/**/*.spec.ts", "docs/objects/invoice.md"]},
            {"name": "b", "write": ["apps/api/src/modules/payments/**/*.spec.ts"]},
        ],
    }
    changed = {
        "apps/api/src/modules/invoices/invoices.due-date.spec.ts": "ok",
        "apps/api/src/modules/invoices/invoices.service.ts": "поза сферами + продукт",
        "apps/web/src/lib/utils.ts": "поза сферами",
    }
    m.dirty_files = lambda: list(changed)
    m.file_hash = lambda f: "new"
    with tempfile.TemporaryDirectory() as tmp:
        pp = os.path.join(tmp, "plan.json")
        with open(pp, "w", encoding="utf-8") as fh:
            json.dump(plan_obj, fh)
        import contextlib
        import io as _io

        buf = _io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = m.cmd_verify(["--plan", pp, "--no-product"])
        out = buf.getvalue()
        assert code == 1, out
        assert out.count("ПОЗА СФЕРАМИ") == 2, out
        assert "ПРОДУКТ-КОД ЗМІНЕНО apps/api/src/modules/invoices/invoices.service.ts" in out, out
        changed.clear()
        changed["apps/api/src/modules/invoices/invoices.due-date.spec.ts"] = "ok"
        changed["docs/objects/invoice.md"] = "ok"
        buf = _io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = m.cmd_verify(["--plan", pp, "--no-product"])
        assert code == 0 and "2 passed (2)" in buf.getvalue(), buf.getvalue()


@case("verify: файл, брудний ще ДО запуску й не змінений агентами, не рахується (snapshot)")
def _():
    m = load()
    m.dirty_files = lambda: ["apps/web/next-env.d.ts"]
    m.file_hash = lambda f: "same"
    with tempfile.TemporaryDirectory() as tmp:
        pp, sp = os.path.join(tmp, "plan.json"), os.path.join(tmp, "snap.json")
        with open(pp, "w", encoding="utf-8") as fh:
            json.dump({"mode": "trace", "shards": [{"name": "a", "write": ["docs/objects/invoice.md"]}]}, fh)
        with open(sp, "w", encoding="utf-8") as fh:
            json.dump({"apps/web/next-env.d.ts": "same"}, fh)
        import contextlib
        import io as _io

        buf = _io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = m.cmd_verify(["--plan", pp, "--snapshot", sp])
        assert code == 0, buf.getvalue()


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
