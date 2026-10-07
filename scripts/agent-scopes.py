#!/usr/bin/env python
"""Сфери запису для паралельних агентів: спланувати, перевірити перетин, звірити після роботи.

НАВІЩО. Кілька агентів в одному робочому дереві безпечні лише тоді, коли їхні файли не
перетинаються. «Агент пообіцяв не чіпати чужого» — не гарантія: тут сфери будуються з коду
(агрегат = дос'є + модуль api + його сторінки), перетин перевіряється ДО запуску, а після —
кожен змінений файл мусить належати рівно одній сфері. Файл поза сферами блокує коміт.

АГРЕГАТ — дос'є `docs/objects/<name>.md` з рядком `**Модуль:**`; для модуля без дос'є
агрегатом є сам модуль. Сторінка `app/(app)/<route>/` належить агрегату, лише якщо на неї
однойменний модуль саме його, або він єдиний, хто її декларує (/catalog ділять goods і works).

РЕЖИМИ (що саме агент може писати):
  trace  — лише тести й дос'є свого агрегату (етап «правило → тест»); продукт-код заборонено
  qa     — нічого (шукачі лише читають); шард = перелік файлів для огляду
  impl   — модуль api та сторінки агрегату цілком

Запуск:
  python scripts/agent-scopes.py plan --mode trace invoice payments      # за назвами дос'є/модулів
  python scripts/agent-scopes.py plan --mode qa --diff 986e2240          # шарди з diff-у
  python scripts/agent-scopes.py plan --mode impl --scope api=apps/api/src/modules/x/** --scope web=...
  python scripts/agent-scopes.py snapshot > before.json                  # ДО запуску агентів
  python scripts/agent-scopes.py verify --plan plan.json --snapshot before.json [--no-product]

`plan` друкує JSON (його ж приймає `verify --plan`). Exit 1 — сфери перетинаються або є
порушення; вивід закінчується рядком у формі verdict.sh.
"""
import glob
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NL = chr(10)
BS = chr(92)


def _selector():
    spec = importlib.util.spec_from_file_location(
        "affected_tests", os.path.join(ROOT, "scripts", "affected-tests.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


SEL = _selector()
API_MODULES = SEL.API_MODULES
WEB_ROUTES = "apps/web/src/app/(app)/"
DOSSIERS = SEL.DOSSIERS


def norm(p):
    return p.replace(BS, "/")


def glob_to_re(pattern):
    """`**` — будь-яка глибина, `*` — у межах одного сегмента. Без `*` — префікс теки/файл."""
    if "*" not in pattern:
        p = re.escape(pattern.rstrip("/"))
        return re.compile("^" + p + "(/.*)?$")
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
        elif pattern.startswith("**", i):
            out += ".*"
            i += 2
        elif pattern[i] == "*":
            out += "[^/]*"
            i += 1
        else:
            out += re.escape(pattern[i])
            i += 1
    return re.compile("^" + out + "$")


def matches(path, patterns):
    return any(glob_to_re(p).match(path) for p in patterns)


# ── агрегати ────────────────────────────────────────────────────────────────────────


def aggregates():
    """{name: {dossier, modules[], routes[]}} — з дос'є; маршрут лише за одноосібної претензії."""
    out = {}
    for p in sorted(glob.glob(os.path.join(ROOT, DOSSIERS, "*.md"))):
        name = os.path.basename(p)[:-3]
        if name.startswith("_"):
            continue
        text = SEL.read(DOSSIERS + name + ".md")
        m = SEL.REG_MODULE.search(text)
        mods = []
        if m:
            for base in m.group(1).split(","):
                seg = base.strip().strip("`").strip("/").split("/")[-1]
                if seg and os.path.isdir(os.path.join(ROOT, API_MODULES, seg)):
                    mods.append(seg)
        out[name] = {"dossier": DOSSIERS + name + ".md", "modules": mods, "routes": []}
    routes = SEL.app_routes()
    declared = SEL.dossier_routes()  # {module: [routes]} із рядка **Маршрути UI:**
    # Власник сторінки — агрегат, чий модуль названо так само (invoices → /invoices). Рядок
    # **Маршрути UI:** у дос'є каже, де агрегат ВИДНО (для вибору E2E), а не чим він володіє:
    # payments видно на /invoices, але сторінка належить invoice. Задекларований маршрут дає
    # власність лише коли однойменного модуля немає і претендент один (/catalog ділять двоє).
    named, declared_by = {}, {}
    for name, agg in out.items():
        for mod in agg["modules"]:
            if mod in routes:
                named.setdefault(mod, []).append(name)
            for r in declared.get(mod, []):
                declared_by.setdefault(r, set()).add(name)
    for r in routes:
        if not os.path.isdir(os.path.join(ROOT, WEB_ROUTES, r)):
            continue
        if r in named:
            if len(named[r]) == 1:
                out[named[r][0]]["routes"].append(r)
        elif os.path.isdir(os.path.join(ROOT, API_MODULES, r)):
            continue  # однойменний модуль без дос'є — сам собі агрегат (pricing-rules)
        elif len(declared_by.get(r, ())) == 1:
            out[next(iter(declared_by[r]))]["routes"].append(r)
    for agg in out.values():
        agg["routes"].sort()
    return out


def resolve(name, aggs):
    """Назва дос'є або модуля → (ім'я агрегату, опис). Модуль без дос'є — агрегат із себе."""
    if name in aggs:
        return name, aggs[name]
    for an, agg in aggs.items():
        if name in agg["modules"]:
            return an, agg
    if os.path.isdir(os.path.join(ROOT, API_MODULES, name)):
        routes = [name] if os.path.isdir(os.path.join(ROOT, WEB_ROUTES, name)) else []
        owned = {r for agg in aggs.values() for r in agg["routes"]}
        return name, {"dossier": None, "modules": [name], "routes": [r for r in routes if r not in owned]}
    return None, None


def aggregate_of(path, aggs):
    """Файл → ім'я агрегату або None (спільний/наскрізний)."""
    path = norm(path)
    if path.startswith(API_MODULES):
        mod = path[len(API_MODULES) :].split("/")[0]
        name, _ = resolve(mod, aggs)
        return name
    if path.startswith(WEB_ROUTES):
        route = path[len(WEB_ROUTES) :].split("/")[0]
        for name, agg in aggs.items():
            if route in agg["routes"]:
                return name
        return None
    if path.startswith(DOSSIERS):
        name = os.path.basename(path)[:-3]
        return name if name in aggs else None
    return None


def write_scope(agg, mode):
    pats = []
    if mode == "qa":
        return pats
    for mod in agg["modules"]:
        base = API_MODULES + mod + "/"
        if mode == "trace":
            pats += [base + "**/*.spec.ts", base + "**/*.spec-fixture.ts"]
        else:
            pats.append(base + "**")
    for r in agg["routes"]:
        base = WEB_ROUTES + r + "/"
        if mode == "trace":
            pats += [base + "**/*.test.ts", base + "**/*.test.tsx"]
        else:
            pats.append(base + "**")
    if agg.get("dossier"):
        pats.append(agg["dossier"])
    return pats


# ── перетин сфер ────────────────────────────────────────────────────────────────────


def sample_paths(pattern):
    """Реальні файли під патерном — на них і шукаємо перетин (точніше за аналіз глобів)."""
    head = pattern.split("*")[0]
    base = os.path.join(ROOT, head)
    if "*" not in pattern:
        return [pattern.rstrip("/")]
    root = base if os.path.isdir(base) else os.path.dirname(base)
    out = []
    for dirpath, _dirs, files in os.walk(root):
        if "node_modules" in dirpath:
            continue
        for f in files:
            rel = norm(os.path.relpath(os.path.join(dirpath, f), ROOT))
            if glob_to_re(pattern).match(rel):
                out.append(rel)
    return out


def overlaps(shards):
    owner, bad = {}, []
    for sh in shards:
        for pat in sh["write"]:
            for f in sample_paths(pat):
                if f in owner and owner[f] != sh["name"]:
                    bad.append((f, owner[f], sh["name"]))
                owner.setdefault(f, sh["name"])
    # патерн без жодного файла на диску: порівнюємо як префікси
    for i, a in enumerate(shards):
        for b in shards[i + 1 :]:
            for pa in a["write"]:
                for pb in b["write"]:
                    ha, hb = pa.split("*")[0], pb.split("*")[0]
                    if ha and hb and (ha.startswith(hb) or hb.startswith(ha)):
                        if not any(x[1:] == (a["name"], b["name"]) for x in bad):
                            if glob_to_re(pa).pattern == glob_to_re(pb).pattern or "*" not in pa or "*" not in pb:
                                bad.append((ha if len(ha) >= len(hb) else hb, a["name"], b["name"]))
    return bad


# ── git ─────────────────────────────────────────────────────────────────────────────


def git(args):
    out = subprocess.run(["git", "-c", "core.quotepath=off"] + args, cwd=ROOT, capture_output=True)
    return [norm(x) for x in out.stdout.decode("utf-8", errors="replace").split(NL) if x.strip()]


def dirty_files():
    files = git(["diff", "--name-only", "HEAD"]) + git(["ls-files", "--others", "--exclude-standard"])
    seen, out = set(), []
    for f in files:
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


def file_hash(path):
    full = os.path.join(ROOT, path)
    if not os.path.isfile(full):
        return "<deleted>"
    with open(full, "rb") as fh:
        return hashlib.sha1(fh.read()).hexdigest()


def is_product(path):
    if not path.endswith((".ts", ".tsx", ".prisma", ".sql")):
        return False
    if not path.startswith(("apps/", "packages/")):
        return False
    name = os.path.basename(path)
    return not (".spec." in name or ".test." in name or ".spec-fixture." in name or "/__tests__/" in path or "/e2e/" in path)


# ── команди ─────────────────────────────────────────────────────────────────────────


def cmd_plan(args):
    mode = "qa"
    if "--mode" in args:
        i = args.index("--mode")
        mode = args[i + 1]
        args = args[:i] + args[i + 2 :]
    assert mode in ("trace", "qa", "impl"), "режим: trace | qa | impl"
    custom = []
    while "--scope" in args:
        i = args.index("--scope")
        name, _, pats = args[i + 1].partition("=")
        custom.append({"name": name, "dossier": None, "write": [p for p in pats.split(",") if p], "files": []})
        args = args[:i] + args[i + 2 :]
    aggs = aggregates()
    shards, cross, unknown = [], [], []
    if "--diff" in args:
        i = args.index("--diff")
        base = args[i + 1]
        files = git(["diff", "--name-only", base]) + git(["ls-files", "--others", "--exclude-standard"])
        if not git(["rev-parse", "--verify", base + "^{commit}"]):
            print("ПЛАН НЕ ПОБУДОВАНО: невідома база %s" % base)
            print("1 failed | 0 passed (1)")
            return 1
        by = {}
        for f in dict.fromkeys(files):
            name = aggregate_of(f, aggs)
            if name is None:
                cross.append(f)
            else:
                by.setdefault(name, []).append(f)
        for name in sorted(by):
            _, agg = resolve(name, aggs)
            shards.append({"name": name, "dossier": agg.get("dossier"), "write": write_scope(agg, mode), "files": by[name]})
    else:
        for raw in args:
            name, agg = resolve(raw, aggs)
            if agg is None:
                unknown.append(raw)
                continue
            if any(s["name"] == name for s in shards):
                continue
            shards.append({"name": name, "dossier": agg.get("dossier"), "write": write_scope(agg, mode), "files": []})
    shards += custom
    bad = overlaps(shards)
    plan = {
        "mode": mode,
        "shards": shards,
        "cross": cross,
        "overlaps": [{"path": p, "a": a, "b": b} for p, a, b in bad],
        "unknown": unknown,
    }
    print(json.dumps(plan, ensure_ascii=False, indent=2))
    problems = len(bad) + len(unknown)
    sys.stderr.write(NL)
    for p, a, b in bad:
        sys.stderr.write("  ПЕРЕТИН СФЕР %s: %s ↔ %s%s" % (p, a, b, NL))
    for u in unknown:
        sys.stderr.write("  НЕВІДОМИЙ АГРЕГАТ %s%s" % (u, NL))
    if not shards:
        sys.stderr.write("  ЖОДНОГО ШАРДА — нічого розподіляти%s" % NL)
        problems += 1
    total = len(shards) + problems
    if problems:
        sys.stderr.write("%d failed | %d passed (%d)%s" % (problems, total - problems, total, NL))
        return 1
    sys.stderr.write("%d passed (%d)%s" % (len(shards), len(shards), NL))
    return 0


def cmd_snapshot(_args):
    print(json.dumps({f: file_hash(f) for f in dirty_files()}, ensure_ascii=False, indent=2))
    return 0


def cmd_verify(args):
    def opt(flag):
        return args[args.index(flag) + 1] if flag in args else None

    plan_path, snap_path = opt("--plan"), opt("--snapshot")
    assert plan_path, "verify потребує --plan <файл>"
    with open(plan_path, encoding="utf-8") as fh:
        plan = json.load(fh)
    before = {}
    if snap_path:
        with open(snap_path, encoding="utf-8") as fh:
            before = json.load(fh)
    no_product = "--no-product" in args
    changed = [f for f in dirty_files() if before.get(f) != file_hash(f)]
    # файл, що був «брудним» до запуску і повернувся до HEAD, теж є зміною стану
    for f, h in before.items():
        if f not in changed and h != file_hash(f):
            changed.append(f)
    problems, per = [], {s["name"]: 0 for s in plan["shards"]}
    for f in changed:
        owners = [s["name"] for s in plan["shards"] if matches(f, s["write"])]
        if not owners:
            problems.append("ПОЗА СФЕРАМИ %s — жоден агент не мав права його писати" % f)
        elif len(owners) > 1:
            problems.append("ДВА ВЛАСНИКИ %s: %s" % (f, ", ".join(owners)))
        else:
            per[owners[0]] += 1
        if no_product and is_product(f):
            problems.append("ПРОДУКТ-КОД ЗМІНЕНО %s — у цьому режимі дозволені лише тести й дос'є" % f)
    for name, n in per.items():
        print("  %-28s змінено файлів: %d" % (name, n))
    for p in problems:
        print("  " + p)
    print()
    if problems:
        print("%d failed | %d passed (%d)" % (len(problems), len(changed) - 0, len(changed) + len(problems)))
        return 1
    print("%d passed (%d)" % (len(changed), len(changed)))
    return 0


def main():
    args = sys.argv[1:]
    if not args or args[0] not in ("plan", "snapshot", "verify"):
        print(__doc__)
        print("0 passed (0)" if False else "НЕ ВИКОНАНО: потрібна команда plan | snapshot | verify")
        return 2
    return {"plan": cmd_plan, "snapshot": cmd_snapshot, "verify": cmd_verify}[args[0]](args[1:])


if __name__ == "__main__":
    sys.exit(main())
