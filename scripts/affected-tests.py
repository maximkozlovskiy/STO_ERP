#!/usr/bin/env python
"""Селектор тестів: «що запускати для цього diff-у».

НАВІЩО. Тести api розкладені по аспектах, але процес цим не користувався: і головний агент,
і QA-агенти ганяли повні набори (api 15 с + web 66 с + E2E ~4 хв), бо не було способу
сказати «лише зачеплене». Цей скрипт — єдина відповідь на питання «що запускати».

ЗВІДКИ ЗНАННЯ. Нічого не зберігається — усе виводиться з коду при кожному запуску:
  · unit (api, web) — граф імпортів, його рахує сам `vitest related`;
  · E2E — маршрут. Карта «спек → маршрути» будується з `page.goto('/…')` у спеках, а
    «змінений файл → маршрути» — зворотним графом імпортів web до сторінок `app/`.
Для api-модуля маршрути шукаються так:
  1. рядок `**Маршрути UI:**` у дос'є агрегату (`docs/objects/*.md`) — явне перевизначення;
  2. інакше однойменна тека в `app/(app)/` (invoices → /invoices) ПЛЮС сторінки, чий власний
     код звертається до URL контролерів модуля (/work-orders створює рахунок → теж у виборі);
  3. без однойменної теки — лише шляхи `@Controller('…')` → web-файли з цими URL → сторінки.
До цього додаються маршрути api-модулів, які (транзитивно) ІМПОРТУЮТЬ змінений файл:
InventoryService правлять в inventory, а ламається він у нарядах і накладних.

ВІДОМА ОПТИМІСТИЧНІСТЬ п.2. Web-файл, який досягає оболонки або понад MAX_ROUTES сторінок
(nav.ts, commands.ts, спільні hooks/api/*), для модуля з однойменною текою НЕ враховується:
літерал '/invoices' там найчастіше href сторінки, а не виклик API, і інакше будь-яка зміна
api давала б «весь E2E». Тобто використання API через спільний хук на чужій сторінці селектор
може не побачити — це ловить повний прогін у CI, який ганяє все завжди.

КОЛИ СКРИПТ КАЖЕ «ПОВНИЙ ПРОГІН». Локальність безпечна лише для локального коду.
Спільний код (shared-пакети, каркас api поза modules/, layout, api-client, конфіги, .env)
зачіпає все, і вгадувати там — означає пропускати падіння. Так само, якщо резолвер імпортів
чогось не розв'язав: невідоме ≠ не зачеплене.

Запуск:
  python scripts/affected-tests.py                  # робоче дерево проти HEAD (+ нові файли)
  python scripts/affected-tests.py --base 206df580  # діапазон <база>..робоче дерево
  python scripts/affected-tests.py <файл> <файл>    # явний список
  python scripts/affected-tests.py --json ...       # машинний вивід (для тесту й агентів)

Скрипт лише РАДИТЬ: нічого не запускає і не змінює; exit 0, коли вибір зроблено.
exit 2 — вибір зробити НЕ ВДАЛОСЬ (git не знає бази, невідомий прапорець): порожній список
змін через помилку не можна видавати за «нічого запускати».
"""
import glob
import io
import json
import os
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

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
# (Каркас api — усе в apps/api/src поза modules/ — визначається правилом у full_reason.)
FULL_PREFIXES = (
    "packages/shared/",
    "packages/database/",
    "packages/ui/",
    "packages/config/",
    "apps/web/src/lib/api-client",
    "apps/web/src/lib/auth/",
    "apps/web/src/contexts/",
    "apps/web/src/i18n/",
    "apps/web/src/__tests__/setup.",  # setupFiles web-vitest: виконується перед кожним тестом
)
FULL_BASENAMES = (
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "turbo.json",
    "tsconfig.json",
    "tsconfig.spec.json",
    "tsconfig.base.json",
    "docker-compose.dev.yml",  # БД/Redis/MinIO, на яких працюють API та E2E
)
FULL_NAME_PARTS = ("vitest.config.", "playwright.config.", "next.config.", "vitest.setup.")

# Web-інфраструктура поза src: unit-тести її не бачать, а кожна сторінка — так.
E2E_FULL_PREFIXES = (
    "apps/web/public/",
    "apps/web/postcss.config.",
    "apps/web/tailwind.config.",
)

# Перевірки поза vitest/Playwright: префікси шляху → команда з кореня репо.
GATES_CMD = "python scripts/check-spec-registry.py --gate-size --gate-registry"
SCRIPT_CHECKS = (
    (
        ("scripts/affected-tests.py", "scripts/test-affected-tests.py", "apps/web/e2e/"),
        "python scripts/test-affected-tests.py",
    ),
    (("scripts/hooks/",), "python scripts/hooks/test-check-claims.py"),
    (
        (
            "scripts/check-spec-registry.py",
            "scripts/spec-baseline.py",
            "docs/objects/",
            "apps/api/test-baseline.json",
        ),
        GATES_CMD,
    ),
)

# Файли, для яких тестів немає за задумом: про них селектор мовчить. Усе інше, чого він
# не зміг прив'язати до тесту, називається у виводі — тиша означала б «перевірено».
SILENT_PREFIXES = ("docs/", ".claude/", ".github/", ".husky/", ".vscode/")
# next-env.d.ts Next переписує сам при кожному старті dev-сервера.
SILENT_BASENAMES = (
    ".gitignore",
    ".prettierignore",
    ".gitattributes",
    ".eslintrc.js",
    "next-env.d.ts",
)
SILENT_EXT = (".md", ".txt")

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

# Довший перелік файлів не влізе в командний рядок Windows (cmd.exe — 8191 символ, а `npx`
# там — це npx.cmd): чесніше порадити весь набір, ніж команду, яка не стартує.
MAX_ARGS_CHARS = 6000

CODE_EXT = (".ts", ".tsx")
IMPORT_RE = re.compile(
    r"""(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]""",
)
# import(…)/require(…) з НЕ-літералом (шаблонний рядок, змінна, коментар перед шляхом):
# IMPORT_RE такого ребра не бачить і не скаржиться — тож воно ловиться окремо як сліпа зона.
OPAQUE_IMPORT_RE = re.compile(r"""\b(?:import|require)\s*\(\s*(?!['"\s)])""")
OPAQUE = "<нелітеральний import()>"
# І `@Controller('x')`, і `@Controller({ path: 'x', version: … })`.
CONTROLLER_RE = re.compile(r"""@Controller\(\s*(?:\{[^}]*?\bpath:\s*)?['"]([^'"]+)['"]""")
GOTO_RE = re.compile(r"""goto\(\s*[`'"](/[a-z0-9-]*)""")
REG_MODULE = re.compile(r"^\*\*Модуль:\*\*\s*(.+)$", re.M)
REG_ROUTES = re.compile(r"^\*\*Маршрути UI:\*\*\s*(.+)$", re.M)


class SelectorError(Exception):
    """Вибір зробити не вдалось — це не те саме, що «нічого запускати»."""


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
    proc = subprocess.run(
        ["git", "-c", "core.quotepath=off"] + args,
        cwd=ROOT,
        capture_output=True,
    )
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", errors="replace").strip()
        raise SelectorError("git %s: %s" % (" ".join(args), err or "exit %d" % proc.returncode))
    out = proc.stdout.decode("utf-8", errors="replace")
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


def to_repo_rel(arg):
    """Аргумент-шлях → шлях від кореня репо.

    Абсолютний, `./x`, відносний до cwd — усе зводиться до одного вигляду; інакше префікси
    не збігаються і файл мовчки випадає з вибору.
    """
    p = norm(arg)
    full = os.path.abspath(p)
    try:
        rel = norm(os.path.relpath(full, ROOT))
    except ValueError:  # інший диск
        rel = ".."
    if not rel.startswith("..") and (os.path.isabs(p) or os.path.exists(full)):
        return rel
    return norm(os.path.normpath(p))


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


_WEB_TEXTS = {}


def web_texts():
    """{шлях: текст} коду web без тестів; читається один раз за запуск."""
    if not _WEB_TEXTS:
        for ext in CODE_EXT:
            for p in glob.glob(os.path.join(ROOT, WEB_SRC, "**", "*" + ext), recursive=True):
                rel = norm(os.path.relpath(p, ROOT))
                if not is_test(rel) and "/__tests__/" not in rel:
                    _WEB_TEXTS[rel] = read(rel)
    return _WEB_TEXTS


def web_files():
    return list(web_texts())


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
    # Саме ФАЙЛ: тека без index.ts(x) — це нерозв'язаний імпорт, а не «не код».
    if os.path.isfile(os.path.join(ROOT, base)):
        return None
    return False


def web_reverse_graph():
    """(reverse, unresolved): reverse[file] = {хто його імпортує}; unresolved = [(хто, що)]."""
    texts = web_texts()
    known = set(texts)
    reverse, unresolved = {}, []
    for f, text in texts.items():
        for m in IMPORT_RE.finditer(text):
            target = resolve_import(m.group(1), f, known)
            if target is False:
                unresolved.append((f, m.group(1)))
            elif target:
                reverse.setdefault(target, set()).add(f)
        if OPAQUE_IMPORT_RE.search(text):
            unresolved.append((f, OPAQUE))
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


def is_shared(reached):
    return "" in reached or len(reached) > MAX_ROUTES


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


def url_hits(mod, reverse):
    """[множина маршрутів] для кожного web-файлу, що містить URL контролерів модуля."""
    patterns = controller_patterns(mod)
    if not patterns:
        return []
    return [
        routes_reached(f, reverse)
        for f, text in web_texts().items()
        if any(p.search(text) for p in patterns)
    ]


def module_routes(mod, primary, ctx):
    """(маршрути, причина «весь E2E» або None) для api-модуля.

    primary — модуль, у якому лежить змінений файл. Інакше це модуль-споживач (імпортує
    змінений файл), і для нього береться лише найближче: власна сторінка або, якщо її
    немає, сторінки з прямими зверненнями до його URL.
    """
    declared = ctx["droutes"].get(mod)
    if declared:
        return set(declared), None
    own = {mod} & ctx["all_routes"]
    if own and not primary:
        return own, None
    hits = url_hits(mod, ctx["reverse"])
    if primary and not own:
        # Сторінки з такою назвою немає, тож літерал URL — це виклик API, а не href.
        via = set().union(*hits) if hits else set()
        if is_shared(via):
            reason = "api-модуль %s використовується на %d+ сторінках" % (mod, len(via - {""}))
            return set(), reason
        return via, None
    direct = set(own)
    for reached in hits:
        if not is_shared(reached):
            direct |= reached
    return direct, None


def api_reverse_graph():
    """reverse[файл] = {хто його імпортує} для коду api (без тестів).

    `*.module.ts` як імпортери пропущені: Nest-модулі імпортують одне одного ланцюжком
    (A → B → C), і через них «залежним» ставало б усе. Справжнє споживання видно з імпорту
    класу сервісу там, де його інжектять.
    """
    files = []
    for p in glob.glob(os.path.join(ROOT, API_SRC, "**", "*.ts"), recursive=True):
        rel = norm(os.path.relpath(p, ROOT))
        if not is_test(rel):
            files.append(rel)
    known = set(files)
    reverse = {}
    for f in files:
        if f.endswith(".module.ts"):
            continue
        for m in IMPORT_RE.finditer(read(f)):
            spec = m.group(1)
            if not spec.startswith("."):
                continue
            base = norm(os.path.normpath(os.path.join(os.path.dirname(f), spec)))
            for target in (base, base + ".ts", base + "/index.ts"):
                if target in known:
                    reverse.setdefault(target, set()).add(f)
                    break
    return reverse


def api_dependents(path, reverse):
    """api-модулі, код яких транзитивно імпортує файл (модуль самого файлу не входить)."""
    seen, stack = {path}, [path]
    while stack:
        for parent in reverse.get(stack.pop(), ()):
            if parent not in seen:
                seen.add(parent)
                stack.append(parent)
    return {api_module(f) for f in seen} - {None, api_module(path)}


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
    # Усе в api/src поза modules/ — каркас застосунку: main.ts, app.module.ts, common/,
    # prisma/, auth/, config/, health/, metrics/, redis/. Перелік тек тут свідомо не
    # ведеться: нова тека каркаса інакше мовчки стала б «локальною».
    if path.startswith(API_SRC) and not path.startswith(API_MODULES):
        return "каркас api (поза modules/)"
    name = os.path.basename(path)
    if name in FULL_BASENAMES or any(part in name for part in FULL_NAME_PARTS):
        return "конфіг: " + name
    if name.startswith(".env") and not name.endswith(".example"):
        return "середовище: " + name
    if path.startswith(E2E_DIR) and not name.endswith(".spec.ts"):
        return "спільна обв'язка E2E: " + name
    # css/json у web/src: граф імпортів будується лише з .ts/.tsx і такого файлу не бачить.
    if path.startswith(WEB_SRC) and not path.endswith(CODE_EXT + SILENT_EXT):
        return "не-код у web/src (граф імпортів його не бачить)"
    return None


def e2e_full_reason(path):
    for prefix in E2E_FULL_PREFIXES:
        if path.startswith(prefix):
            return "web-інфраструктура: " + prefix
    return None


def script_checks(path):
    cmds = [cmd for keys, cmd in SCRIPT_CHECKS if path.startswith(keys)]
    # Чіпав api-спек → гейти (втрачений кейс, новий моноліт, реєстр дос'є).
    if path.startswith(API_SRC) and is_test(path) and GATES_CMD not in cmds:
        cmds.append(GATES_CMD)
    if path.endswith(".md"):
        cmds.append("python scripts/check-doc-links.py")
    return cmds


def is_silent(path):
    name = os.path.basename(path)
    return (
        path.startswith(SILENT_PREFIXES)
        or name in SILENT_BASENAMES
        or name.endswith(SILENT_EXT)
    )


def dedupe(items):
    seen, out = set(), []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def quote(paths, strip):
    return " ".join('"%s"' % p[len(strip) :] for p in paths)


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
        "scripts": [],
        "uncovered": [],
    }
    smap = spec_routes()
    ctx = {"all_routes": app_routes(), "droutes": dossier_routes(), "reverse": None}
    unresolved = api_reverse = None
    routes, api_units, web_units, direct_specs = set(), [], [], []
    web_code_changed = False
    route_cache = {}

    def need_web_graph():
        nonlocal unresolved
        if ctx["reverse"] is None:
            ctx["reverse"], unresolved = web_reverse_graph()

    def e2e_everything(reason):
        res["e2e_full"] = True
        res["reasons"].append(reason)

    for f in files:
        handled = False
        reason = full_reason(f)
        if reason:
            res["full"] = True
            res["reasons"].append("%s (%s)" % (reason, f))
            handled = True
        reason = e2e_full_reason(f)
        if reason:
            e2e_everything("%s (%s)" % (reason, f))
            handled = True
        checks = script_checks(f)
        if checks:
            res["scripts"] += checks
            handled = True
        code = f.endswith(CODE_EXT)

        if f.startswith(E2E_DIR) and f.endswith(".spec.ts"):
            if exists(f):
                direct_specs.append(os.path.basename(f))
            continue

        if f.startswith(API_SRC):
            if code and exists(f):
                api_units.append(f)
            mod = api_module(f)
            if mod is None:
                continue  # каркас api — уже «повний прогін» у full_reason
            # Усі спеки теки модуля: `vitest related` не бачить зв'язків через DI-токени.
            # Не-код модуля (шаблон, json) іде цим самим шляхом — як зміна модуля.
            mod_glob = os.path.join(ROOT, API_MODULES, mod, "**", "*.spec.ts")
            for p in glob.glob(mod_glob, recursive=True):
                api_units.append(norm(os.path.relpath(p, ROOT)))
            if is_test(f):
                continue
            need_web_graph()
            if api_reverse is None:
                api_reverse = api_reverse_graph()
            file_routes = set()
            consumers = sorted(api_dependents(f, api_reverse))
            for m, primary in [(mod, True)] + [(d, False) for d in consumers]:
                key = (m, primary)
                if key not in route_cache:
                    route_cache[key] = module_routes(m, primary, ctx)
                found, why = route_cache[key]
                if why and why not in res["reasons"]:
                    e2e_everything(why)
                if why:
                    file_routes.add("")  # визначено: весь E2E
                file_routes |= found
            if not file_routes and mod not in res["e2e_undetermined"]:
                res["e2e_undetermined"].append(mod)
            routes.update(file_routes - {""})
            continue

        if f.startswith(WEB_SRC) and code:
            if exists(f):
                web_units.append(f)
            if is_test(f) or "/__tests__/" in f:
                continue
            web_code_changed = True
            need_web_graph()
            reached = routes_reached(f, ctx["reverse"])
            stem = os.path.splitext(os.path.basename(f))[0]
            opaque = [imp for imp, spec in unresolved if spec == OPAQUE]
            blind = [imp for imp, spec in unresolved if spec.split("/")[-1] == stem]
            if opaque:
                e2e_everything("%s у %s — граф імпортів web неповний" % (OPAQUE, opaque[0]))
            elif blind:
                e2e_everything("нерозв'язаний імпорт на %s у %s — граф неповний" % (stem, blind[0]))
            elif "" in reached:
                e2e_everything("імпортується оболонкою всіх сторінок (layout): " + f)
            elif len(reached) > MAX_ROUTES:
                e2e_everything("спільний компонент: %s досягає %d маршрутів" % (f, len(reached)))
            elif not reached:
                res["notes"].append(
                    "web-файл не досягає жодної сторінки — E2E для нього не обрано: " + f
                )
            else:
                routes.update(reached)
            continue

        if not handled and not is_silent(f):
            res["uncovered"].append(f)

    res["api"] = dedupe(api_units)
    res["web"] = dedupe(web_units)
    res["scripts"] = dedupe(res["scripts"])
    res["routes"] = sorted(routes)
    # Команда, що не влізе в рядок, не стартує взагалі — тоді радимо весь набір.
    res["api_all"] = len(quote(res["api"], "apps/api/")) > MAX_ARGS_CHARS
    res["web_all"] = len(quote(res["web"], "apps/web/")) > MAX_ARGS_CHARS

    specs = set(direct_specs) | set(specs_for_routes(routes, smap))
    no_e2e = sorted(r for r in routes if not specs_for_routes([r], smap))
    if no_e2e:
        res["notes"].append("маршрути без жодного E2E-спека: " + ", ".join(no_e2e))
    # Наскрізні спеки (a11y, console-errors, smoke…) обходять усі сторінки й коштують
    # дорого; вони стережуть web-код, тож для зміни лише api не додаються. Для сторінки
    # без власного спека вони — єдина варта, тому умова — маршрут, а не знайдений спек.
    if web_code_changed and (specs or routes):
        specs |= set(CROSS_E2E) & set(smap)
    res["e2e"] = sorted(specs)
    if res["full"]:
        res["e2e_full"] = True
    return res


def render(res):
    lines = ["ЗАЧЕПЛЕНІ ТЕСТИ — %d змінених файлів" % len(res["changed"]), ""]
    tail = []
    for cmd in res["scripts"]:
        tail.append("ІНШЕ: " + cmd)
    if res["e2e_undetermined"]:
        tail.append(
            "E2E НЕ ВИЗНАЧЕНО для api-модулів: %s — web до них не звертається (або модуль"
            " без контролера). Якщо UI все ж є — додати **Маршрути UI:** у дос'є."
            % ", ".join(res["e2e_undetermined"])
        )
    if res["uncovered"]:
        tail.append(
            "ПОЗА СЕЛЕКТОРОМ (тесту для них він не знає — це НЕ «перевірено»): "
            + ", ".join(res["uncovered"])
        )
    for note in res["notes"]:
        tail.append("УВАГА: " + note)

    if not (res["api"] or res["web"] or res["e2e"] or res["full"] or res["e2e_full"]):
        lines.append("Нічого запускати з vitest/Playwright: зміни не зачіпають код із тестами.")
        return NL.join(lines + tail)

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
        return NL.join(lines + tail)

    lines.append("ПОВНИЙ ПРОГІН ПОТРІБЕН: ні")
    lines.append("")
    too_long = "        # ВЕСЬ набір: перелік із %d файлів не влізе в командний рядок"
    for label, key, strip in (("API", "api", "apps/api/"), ("WEB", "web", "apps/web/")):
        if not res[key]:
            lines.append("%s : —" % label)
        elif res[key + "_all"]:
            lines.append(
                "%s : cd %s && npx vitest run" % (label, strip.rstrip("/"))
                + too_long % len(res[key])
            )
        else:
            lines.append(
                "%s : cd %s && npx vitest related %s --run"
                % (label, strip.rstrip("/"), quote(res[key], strip))
            )
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
    return NL.join(lines + tail)


def main():
    args = sys.argv[1:]
    as_json = "--json" in args
    args = [a for a in args if a != "--json"]
    base = "HEAD"
    try:
        if "--base" in args:
            i = args.index("--base")
            if i + 1 >= len(args):
                raise SelectorError("--base потребує значення (sha або гілка)")
            base = args[i + 1]
            args = args[:i] + args[i + 2 :]
        unknown = [a for a in args if a.startswith("--")]
        if unknown:
            # Інакше прапорець з одруківкою став би «файлом», для якого нічого запускати.
            raise SelectorError("невідомий прапорець: " + " ".join(unknown))
        files = [to_repo_rel(a) for a in args] if args else changed_files(base)
    except SelectorError as exc:
        print("ВИБІР НЕ ЗРОБЛЕНО: %s" % exc, file=sys.stderr)
        print("ВИБІР НЕ ЗРОБЛЕНО — це не «нічого запускати». Причина — у stderr.")
        return 2
    res = select(files)
    print(json.dumps(res, ensure_ascii=False, indent=2) if as_json else render(res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
