#!/usr/bin/env python
"""Перевірка «що бачить `next build` в образі»: жоден файл, потрібний збиранню web, не виключений
`.dockerignore`.

НАВІЩО. 2026-10-16 `playwright.config.ts` почав імпортувати `./e2e/api-url`, а `apps/web/e2e`
виключено з Docker-контексту — CI `docker-build` упав на перевірці типів (TS2307), хоча локальні
tsc/prepush були чисті: вони бачать повне дерево. Docker локально є не завжди, тож перевіряємо
дешевше й точніше: `tsc --listFilesOnly` (без перевірки типів) збирає ВСІ файли програми web, які
лишаються після `.dockerignore`, РАЗОМ з імпортованими; якщо серед них є файл, що в образ не
потрапить, — збій. (`exclude` у tsconfig тут не допоміг би: імпортований файл tsc знаходить усе одно.)

    python scripts/check-docker-context.py            # exit 0 — чисто, 1 — є проблема
    python scripts/check-docker-context.py --self-test
"""
import json
import os
import re
import subprocess
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "apps", "web")


def load_patterns(text):
    pats = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("!"):
            continue
        pats.append(s.strip("/"))
    return pats


def to_regex(pat):
    """Шаблон .dockerignore (відносно кореня контексту) → regex для шляху з «/»."""
    out, i = "", 0
    while i < len(pat):
        if pat.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
        elif pat.startswith("**", i):
            out += ".*"
            i += 2
        elif pat[i] == "*":
            out += "[^/]*"
            i += 1
        elif pat[i] == "?":
            out += "[^/]"
            i += 1
        else:
            out += re.escape(pat[i])
            i += 1
    # шаблон каталогу виключає й усе всередині
    return re.compile("^" + out + "(?:/.*)?$")


# Згенероване самим `next build` (типи маршрутів, на які посилається next-env.d.ts): в образі
# з'являється під час збирання, тож його відсутність у контексті — не проблема.
GENERATED = re.compile(r"^apps/web/\.next[^/]*/")


def ignored(rel, regexes):
    return any(r.match(rel) for r in regexes)


def web_exclude_globs(pats):
    """Шаблони, що стосуються apps/web, у вигляді `exclude` для tsconfig (відносно apps/web)."""
    out = ["node_modules"]
    for p in pats:
        if p.startswith("apps/web/"):
            out.append(p[len("apps/web/"):])
        elif p.startswith("**/"):
            out.append(p)
    return out


def tsc_bin():
    """`tsc` з node_modules/.bin — напряму, без `npx` і shell: npx на кожен виклик шукає пакет
    і на Windows іде через cmd.exe. Спершу bin пакета web (те, що бачить `npx` у його теці), далі
    кореня монорепо. На Windows pnpm кладе поруч `tsc.CMD` — запускається тільки він."""
    name = "tsc.cmd" if os.name == "nt" else "tsc"
    for base in (WEB, ROOT):
        p = os.path.join(base, "node_modules", ".bin", name)
        if os.path.isfile(p):
            return p
    return None


def program_files():
    pats = load_patterns(open(os.path.join(ROOT, ".dockerignore"), encoding="utf-8").read())
    regexes = [to_regex(p) for p in pats]
    fd, cfg = tempfile.mkstemp(prefix="tsconfig.docker-", suffix=".json", dir=WEB)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"extends": "./tsconfig.json", "exclude": web_exclude_globs(pats)}, f)
    tsc = tsc_bin()
    if not tsc:
        os.remove(cfg)
        return [], regexes, 1, "не знайдено node_modules/.bin/tsc — pnpm install"
    try:
        r = subprocess.run(
            [tsc, "--listFilesOnly", "-p", os.path.basename(cfg)],
            cwd=WEB, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
    finally:
        os.remove(cfg)
    files = []
    for line in r.stdout.splitlines():
        p = line.strip().replace("\\", "/")
        if not p:
            continue
        rel = os.path.relpath(p, ROOT).replace("\\", "/")
        if rel.startswith("..") or "/node_modules/" in "/" + rel:
            continue
        files.append(rel)
    return files, regexes, r.returncode, r.stderr


def self_test():
    rx = [to_regex(p) for p in load_patterns("apps/web/e2e\n**/__tests__\n**/*.test.ts\ncoverage\n# c\n")]
    cases = [
        ("apps/web/e2e/api-url.ts", True),
        ("apps/web/src/lib/__tests__/x.ts", True),
        ("apps/web/src/a.test.ts", True),
        ("coverage/lcov.info", True),
        ("apps/web/src/lib/coverage.ts", False),
        ("apps/web/e2e-helpers.ts", False),
        ("apps/web/playwright.config.ts", False),
    ]
    bad = [(p, w) for p, w in cases if ignored(p, rx) != w]
    if not GENERATED.match("apps/web/.next/dev/types/routes.d.ts") or GENERATED.match("apps/web/src/a.ts"):
        bad.append(("GENERATED", "apps/web/.next/** — лише згенероване"))
    for p, w in bad:
        print(f"FAIL self-test: {p} очікувано ignored={w}")
    print(f"{len(cases) - len(bad)} passed ({len(cases)})" if not bad else f"{len(bad)} failed ({len(cases)})")
    return 1 if bad else 0


def main():
    if "--self-test" in sys.argv:
        return self_test()
    files, regexes, rc, err = program_files()
    if not files:
        print("❌ docker-context: tsc не повернув жодного файла" + (f" (exit {rc}): {err[:300]}" if err else ""))
        return 1
    leaked = [f for f in files if ignored(f, regexes) and not GENERATED.match(f)]
    if leaked:
        print("❌ docker-context: файли, потрібні збиранню web, виключено .dockerignore —")
        print("   `next build` в образі їх не знайде:")
        for f in leaked[:20]:
            print(f"   • {f}")
        print("   Виключи з образу й того, хто їх імпортує, або прибери імпорт.")
        return 1
    print(f"✅ docker-context: {len(files)} файлів програми web — усі потрапляють в образ")
    print(f"{len(files)} passed ({len(files)})")  # формат, який розпізнає verdict.sh
    return 0


if __name__ == "__main__":
    sys.exit(main())
