#!/usr/bin/env python
"""Селектор тестів: «що запускати для цього diff-у».

НАВІЩО. Тести api розкладені по аспектах, але процес цим не користувався: і головний агент,
і QA-агенти ганяли повні набори (api 15 с + web 66 с + E2E ~4 хв), бо не було способу
сказати «лише зачеплене». Цей скрипт — єдина відповідь на питання «що запускати».

ЗВІДКИ ЗНАННЯ. Нічого не зберігається — усе виводиться з коду при кожному запуску:
  · unit (api, web) — граф імпортів, його рахує сам `vitest related`;
  · E2E — маршрут. Карта «спек → маршрути» будується з `page.goto('/…')` у спеках, а
    «змінений файл → маршрути» — зворотним графом імпортів web до сторінок `app/`.
Для api-модуля маршрути шукаються так (перше, що спрацювало):
  1. рядок `**Маршрути UI:**` у дос'є агрегату (`docs/objects/*.md`) — явне перевизначення;
  2. однойменна тека в `app/(app)/` (invoices → /invoices);
  3. шляхи `@Controller('…')` модуля → web-файли, що звертаються до цих URL → їхні сторінки.

КОЛИ СКРИПТ КАЖЕ «ПОВНИЙ ПРОГІН». Локальність безпечна лише для локального коду.
Спільний код (shared-пакети, common/, prisma/, layout, api-client, конфіги) зачіпає все,
і вгадувати там — означає пропускати падіння. Так само, якщо резолвер імпортів чогось не
розв'язав: невідоме ≠ не зачеплене.

Запуск:
  python scripts/affected-tests.py                  # робоче дерево проти HEAD (+ нові файли)
  python scripts/affected-tests.py --base 206df580  # діапазон <база>..робоче дерево
  python scripts/affected-tests.py <файл> <файл>    # явний список
  python scripts/affected-tests.py --json ...       # машинний вивід (для тесту й агентів)

Скрипт лише РАДИТЬ: завжди exit 0, нічого не запускає і не змінює.
"""
import glob
import io
import json
import os
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NL = chr(10)
BS = chr(92)

API_SRC = "apps/api/src/"
API_MODULES = "apps/api/src/modules/"
WEB_SRC = "apps/web/src/"
WEB_APP = "apps/web/src/app/"
E2E_DIR = "apps/web/e2e/"
DOSSIERS = "docs/objects/"

# Спільний код: зміна тут зачіпає все, локальний вибір небезпечний.
FULL_PREFIXES = (
    "packages/shared/",
    "packages/database/",
    "packages/ui/",
    "packages/config/",
    "apps/api/src/common/",
    "apps/api/src/prisma/",
    "apps/api/src/auth/",
    "apps/api/src/config/",
    "apps/web/src/lib/api-client",
    "apps/web/src/lib/auth/",
    "apps/web/src/contexts/",
    "apps/web/src/i18n/",
)
FULL_BASENAMES = (
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "turbo.json",
    "tsconfig.json",
    "tsconfig.spec.json",
    "tsconfig.base.json",
)
FULL_NAME_PARTS = ("vitest.config.", "playwright.config.", "next.config.", "vitest.setup.")

# Наскрізні E2E: не належать одному маршруту, додаються до вибору, коли змінено web-код.
CROSS_E2E = (
    "a11y.spec.ts",
    "api-errors.spec.ts",
    "auth-flow.spec.ts",
    "command-palette.spec.ts",
    "console-errors.spec.ts",
    "smoke.spec.ts",
)

# Файл, що досягає більше маршрутів, — спільний компонент: ганяти весь E2E.
MAX_ROUTES = 6

CODE_EXT = (".ts", ".tsx")
IMPORT_RE = re.compile(
    r"""(?:from|import)\s*\(?\s*['"]([^'"]+)['"]""",
)
CONTROLLER_RE = re.compile(r"""@Controller\(\s*['"]([^'"]+)['"]""")
GOTO_RE = re.compile(r"""goto\(\s*[`'"](/[a-z0-9-]*)""")
REG_MODULE = re.compile(r"^\*\*Модуль:\*\*\s*(.+)$", re.M)
REG_ROUTES = re.compile(r"^\*\*Маршрути UI:\*\*\s*(.+)$", re.M)


def norm(p):
    return p.replace(BS, "/")


def read(path):
    with io.open(os.path.join(ROOT, path), encoding="utf-8", errors="replace") as fh:
        return fh.read()


def exists(path):
    return os.path.isfile(os.path.join(ROOT, path))


def is_test(path):
    name = os.path.basename(path)
    return ".spec." in name or ".test." in name


def git_lines(args):
    out = subprocess.run(
        ["git", "-c", "core.quotepath=off"] + args,
        cwd=ROOT,
        capture_output=True,
    ).stdout.decode("utf-8", errors="replace")
    return [norm(line.strip()) for line in out.split(NL) if line.strip()]


def changed_files(base):
    files = git_lines(["diff", "--name-only", base])
    files += git_lines(["ls-files", "--others", "--exclude-standard"])
    seen, out = set(), []
    for f in files:
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


# ── E2E: карта «спек → маршрути» з goto ─────────────────────────────────────────────


def e2e_specs():
    pattern = os.path.join(ROOT, E2E_DIR, "*.spec.ts")
    return sorted(os.path.basename(p) for p in glob.glob(pattern))


def spec_routes():
    """{spec: {route}} — маршрут це перший сегмент шляху з page.goto('/…')."""
    out = {}
    for spec in e2e_specs():
        routes = {m.group(1).strip("/") for m in GOTO_RE.finditer(read(E2E_DIR + spec))}
        out[spec] = {r for r in routes if r}
    return out


def specs_for_routes(routes, smap):
    return sorted(s for s, rs in smap.items() if rs & set(routes) and s not in CROSS_E2E)


# ── web: маршрути та зворотний граф імпортів ────────────────────────────────────────


def route_of(path):
    """apps/web/src/app/(app)/invoices/page.tsx → 'invoices'. None, якщо файл не під app/.

    '' — файл у корені app/ або в корені групи ((app)/layout.tsx): це оболонка всіх сторінок.
    """
    if not path.startswith(WEB_APP):
        return None
    parts = [p for p in path[len(WEB_APP) :].split("/")[:-1] if not p.startswith("(")]
    parts = [p for p in parts if p != "__tests__"]
    return parts[0] if parts else ""


def web_files():
    out = []
    for ext in CODE_EXT:
        for p in glob.glob(os.path.join(ROOT, WEB_SRC, "**", "*" + ext), recursive=True):
            rel = norm(os.path.relpath(p, ROOT))
            if not is_test(rel) and "/__tests__/" not in rel:
                out.append(rel)
    return out


def resolve_import(spec, importer, known):
    """Локальний імпорт → шлях файлу. None = зовнішній пакет. False = не розв'язано."""
    if spec.startswith("@/"):
        base = WEB_SRC + spec[2:]
    elif spec.startswith("."):
        base = norm(os.path.normpath(os.path.join(os.path.dirname(importer), spec)))
    else:
        return None
    if base in known:
        return base
    for ext in CODE_EXT:
        if base + ext in known:
            return base + ext
    for ext in CODE_EXT:
        if base + "/index" + ext in known:
            return base + "/index" + ext
    # Не код (css, json, зображення) — існує на диску, але в графі нас не цікавить.
    if os.path.exists(os.path.join(ROOT, base)):
        return None
    return False


def web_reverse_graph():
    """(reverse, unresolved): reverse[file] = {хто його імпортує}; unresolved = [(хто, що)]."""
    files = web_files()
    known = set(files)
    reverse, unresolved = {}, []
    for f in files:
        for m in IMPORT_RE.finditer(read(f)):
            target = resolve_import(m.group(1), f, known)
            if target is False:
                unresolved.append((f, m.group(1)))
            elif target:
                reverse.setdefault(target, set()).add(f)
    return reverse, unresolved


def routes_reached(path, reverse):
    """Маршрути, сторінки яких (транзитивно) імпортують файл. '' у множині = оболонка."""
    seen, stack, routes = {path}, [path], set()
    while stack:
        cur = stack.pop()
        r = route_of(cur)
        if r is not None:
            routes.add(r)
        for parent in reverse.get(cur, ()):
            if parent not in seen:
                seen.add(parent)
                stack.append(parent)
    return routes


# ── api: модуль → маршрути ──────────────────────────────────────────────────────────


def app_routes():
    out = set()
    for group in glob.glob(os.path.join(ROOT, WEB_APP, "*")):
        name = os.path.basename(group)
        if not os.path.isdir(group) or name == "__tests__":
            continue
        if name.startswith("("):
            for sub in glob.glob(os.path.join(group, "*")):
                if os.path.isdir(sub) and os.path.basename(sub) != "__tests__":
                    out.add(os.path.basename(sub))
        else:
            out.add(name)
    return out


def dossier_routes():
    """{api-модуль: [маршрути]} з рядків **Модуль:** + **Маршрути UI:** у дос'є."""
    out = {}
    for p in sorted(glob.glob(os.path.join(ROOT, DOSSIERS, "*.md"))):
        text = read(norm(os.path.relpath(p, ROOT)))
        mod, routes = REG_MODULE.search(text), REG_ROUTES.search(text)
        if not (mod and routes):
            continue
        found = re.findall(r"/([a-z0-9-]+)", routes.group(1))
        for base in mod.group(1).split(","):
            name = base.strip().strip("`").strip("/").split("/")[-1]
            if name:
                out[name] = found
    return out


def controller_patterns(mod):
    """Регекси URL-літералів web для кожного `@Controller('…')` модуля.

    'work-orders/:workOrderId/media' → літерал, що починається з /work-orders/<будь-що>/media.
    """
    out = []
    pattern = os.path.join(ROOT, API_MODULES, mod, "**", "*.controller.ts")
    for p in glob.glob(pattern, recursive=True):
        for m in CONTROLLER_RE.finditer(read(norm(os.path.relpath(p, ROOT)))):
            segs = [x for x in m.group(1).strip("/").split("/") if x]
            if not segs or segs[0].startswith(":"):
                continue
            body = "/".join("[^/'\"`?]+" if x.startswith(":") else re.escape(x) for x in segs)
            out.append(re.compile("['\"`]/" + body + "(?=[/'\"`?$])"))
    return out


def routes_via_urls(mod, reverse):
    """Маршрути сторінок, код яких звертається до URL контролерів модуля."""
    patterns = controller_patterns(mod)
    if not patterns:
        return set()
    routes = set()
    for f in web_files():
        text = read(f)
        if any(p.search(text) for p in patterns):
            routes |= routes_reached(f, reverse)
    return routes


def api_module(path):
    if not path.startswith(API_MODULES):
        return None
    return path[len(API_MODULES) :].split("/")[0]


# ── головна логіка ──────────────────────────────────────────────────────────────────


def full_reason(path):
    # Зміна лише тесту зачіпає лише цей тест — навіть якщо він лежить у спільній теці.
    if is_test(path) and path.endswith(CODE_EXT):
        return None
    for prefix in FULL_PREFIXES:
        if path.startswith(prefix):
            return "спільний код: " + prefix
    name = os.path.basename(path)
    if name in FULL_BASENAMES or any(part in name for part in FULL_NAME_PARTS):
        return "конфіг: " + name
    if path.startswith(E2E_DIR) and not name.endswith(".spec.ts"):
        return "спільна обв'язка E2E: " + name
    return None


def select(files):
    files = [norm(f) for f in files]
    res = {
        "changed": files,
        "api": [],
        "web": [],
        "e2e": [],
        "e2e_full": False,
        "e2e_undetermined": [],
        "full": False,
        "reasons": [],
        "notes": [],
    }
    smap = spec_routes()
    all_routes = app_routes()
    droutes = dossier_routes()
    reverse = unresolved = None
    routes, api_units, web_units, direct_specs = set(), [], [], []
    web_code_changed = False
    seen_mods = set()

    for f in files:
        reason = full_reason(f)
        if reason:
            res["full"] = True
            res["reasons"].append("%s (%s)" % (reason, f))
        if not f.endswith(CODE_EXT):
            continue

        if f.startswith(E2E_DIR) and f.endswith(".spec.ts"):
            if exists(f):
                direct_specs.append(os.path.basename(f))
            continue

        if f.startswith(API_SRC):
            if exists(f):
                api_units.append(f)
            mod = api_module(f)
            if mod is None:
                continue
            # Усі спеки теки модуля: `vitest related` не бачить зв'язків через DI-токени.
            mod_glob = os.path.join(ROOT, API_MODULES, mod, "**", "*.spec.ts")
            for p in glob.glob(mod_glob, recursive=True):
                api_units.append(norm(os.path.relpath(p, ROOT)))
            if is_test(f):
                continue
            mod_routes = droutes.get(mod) or ([mod] if mod in all_routes else [])
            if mod_routes:
                routes.update(mod_routes)
                continue
            if mod in seen_mods:
                continue
            seen_mods.add(mod)
            if reverse is None:
                reverse, unresolved = web_reverse_graph()
            via = routes_via_urls(mod, reverse)
            if not via:
                res["e2e_undetermined"].append(mod)
            elif "" in via or len(via) > MAX_ROUTES:
                res["e2e_full"] = True
                res["reasons"].append(
                    "api-модуль %s використовується на %d+ сторінках" % (mod, len(via - {""}))
                )
            else:
                routes.update(via)
            continue

        if f.startswith(WEB_SRC):
            if exists(f):
                web_units.append(f)
            if is_test(f) or "/__tests__/" in f:
                continue
            web_code_changed = True
            if reverse is None:
                reverse, unresolved = web_reverse_graph()
            reached = routes_reached(f, reverse)
            stem = os.path.splitext(os.path.basename(f))[0]
            blind = [imp for imp, spec in unresolved if spec.split("/")[-1] == stem]
            if blind:
                res["e2e_full"] = True
                res["reasons"].append(
                    "нерозв'язаний імпорт на %s у %s — граф неповний" % (stem, blind[0])
                )
            elif "" in reached:
                res["e2e_full"] = True
                res["reasons"].append("імпортується оболонкою всіх сторінок (layout): " + f)
            elif len(reached) > MAX_ROUTES:
                res["e2e_full"] = True
                res["reasons"].append(
                    "спільний компонент: %s досягає %d маршрутів" % (f, len(reached))
                )
            else:
                routes.update(reached)

    def dedupe(items):
        seen, out = set(), []
        for item in items:
            if item not in seen:
                seen.add(item)
                out.append(item)
        return out

    res["api"] = dedupe(api_units)
    res["web"] = dedupe(web_units)
    res["routes"] = sorted(routes)

    specs = set(direct_specs) | set(specs_for_routes(routes, smap))
    no_e2e = sorted(r for r in routes if not specs_for_routes([r], smap))
    if no_e2e:
        res["notes"].append("маршрути без жодного E2E-спека: " + ", ".join(no_e2e))
    # Наскрізні спеки (a11y, console-errors, smoke…) обходять усі сторінки й коштують
    # дорого; вони стережуть web-код, тож для зміни лише api не додаються.
    if specs and web_code_changed:
        specs |= set(CROSS_E2E) & set(smap)
    res["e2e"] = sorted(specs)
    if res["full"]:
        res["e2e_full"] = True
    return res


def quote(paths, strip):
    return " ".join('"%s"' % p[len(strip) :] for p in paths)


def render(res):
    lines = ["ЗАЧЕПЛЕНІ ТЕСТИ — %d змінених файлів" % len(res["changed"]), ""]
    if not (res["api"] or res["web"] or res["e2e"] or res["full"] or res["e2e_full"]):
        lines.append("Нічого запускати: зміни не зачіпають код із тестами.")
        if res["e2e_undetermined"]:
            lines.append("E2E не визначено для: " + ", ".join(res["e2e_undetermined"]))
        return NL.join(lines)

    if res["full"]:
        lines.append("ПОВНИЙ ПРОГІН ПОТРІБЕН: так")
        for r in res["reasons"]:
            lines.append("  · " + r)
        lines += [
            "",
            "API : cd apps/api && npx vitest run",
            "WEB : cd apps/web && npx vitest run",
            "E2E : cd apps/web && npx playwright test",
        ]
        return NL.join(lines)

    lines.append("ПОВНИЙ ПРОГІН ПОТРІБЕН: ні")
    lines.append("")
    if res["api"]:
        lines.append("API : cd apps/api && npx vitest related %s --run" % quote(res["api"], "apps/api/"))
    else:
        lines.append("API : —")
    if res["web"]:
        lines.append("WEB : cd apps/web && npx vitest related %s --run" % quote(res["web"], "apps/web/"))
    else:
        lines.append("WEB : —")
    if res["e2e_full"]:
        lines.append("E2E : cd apps/web && npx playwright test        # ВЕСЬ suite")
        for r in res["reasons"]:
            lines.append("  · " + r)
    elif res["e2e"]:
        specs = " ".join("e2e/" + s for s in res["e2e"])
        lines.append("E2E : cd apps/web && npx playwright test " + specs)
        lines.append("      маршрути: " + ", ".join("/" + r for r in res["routes"]))
    else:
        lines.append("E2E : —")
    if res["e2e_undetermined"]:
        lines.append(
            "E2E НЕ ВИЗНАЧЕНО для api-модулів: %s — web до них не звертається (або модуль"
            " без контролера). Якщо UI все ж є — додати **Маршрути UI:** у дос'є."
            % ", ".join(res["e2e_undetermined"])
        )
    for note in res["notes"]:
        lines.append("УВАГА: " + note)
    return NL.join(lines)


def main():
    args = sys.argv[1:]
    as_json = "--json" in args
    args = [a for a in args if a != "--json"]
    base = "HEAD"
    if "--base" in args:
        i = args.index("--base")
        base = args[i + 1]
        args = args[:i] + args[i + 2 :]
    files = args if args else changed_files(base)
    res = select(files)
    print(json.dumps(res, ensure_ascii=False, indent=2) if as_json else render(res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
