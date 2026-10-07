#!/usr/bin/env python
"""Гейт розміру скілів: файл, який агент мусить прочитати, має влазити в один Read.

НАВІЩО. Агентам наказано читати скіл цілком, але один Read віддає до 25 000 токенів
(~39 КБ кирилиці). `sto-tester/SKILL.md` був 364 КБ — агент читав 5–10% і різав файл
`sed`-ом навмання, тож більшість чекліста в прогоні участі не брала.

ЧОМУ КБ, А НЕ РЯДКИ. Старе правило «не більше 1500 рядків» той самий файл проходив
(1362 рядки): 75% його обсягу лежало в 166 рядках довших за 500 символів.

ЛІМІТИ
  SKILL.md                 ≤ 32 КБ   ядро: алгоритм + матриця «тип зміни → секції»
  будь-який інший .md      ≤ 36 КБ   секція — читається цілком, коли її призначила матриця
  journal/**               без ліміту на файл — це архів випадків, його не читають цілком;
                           звертаються пошуком

Запуск:
  python scripts/check-skill-size.py          # вердикт у формі verdict.sh
  python scripts/check-skill-size.py --list   # усі файли з розмірами
"""
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILLS = os.path.join(ROOT, ".claude", "skills")
BS = chr(92)

CORE_LIMIT_KB = 32
SECTION_LIMIT_KB = 36


def kb(path):
    # Розмір рахується як у репозиторії (LF): checkout із core.autocrlf=true додає байт на
    # рядок (+2–3%), і файл біля межі був би «понад ліміт» на Windows та «в нормі» в CI.
    with open(path, "rb") as fh:
        data = fh.read()
    return (len(data) - data.count(bytes((13, 10)))) / 1024.0


def md_files(root):
    # os.walk, а не glob('*.md'): glob на Linux чутливий до регістру, тож `BIG.MD` гейт
    # бачив би на Windows і пропускав би в CI.
    found = []
    for base, _dirs, names in os.walk(root):
        found.extend(os.path.join(base, n) for n in names if n.lower().endswith(".md"))
    return sorted(found)


def classify(rel):
    """rel — шлях від .claude/skills/. Повертає (вид, ліміт у КБ або None)."""
    parts = rel.split("/")
    # Лише <скіл>/journal/…: тека `journal` глибше (sections/journal/) або скіл із назвою
    # `journal` ліміту не уникають — інакше будь-який файл ховається від гейта перейменуванням теки.
    if len(parts) >= 3 and parts[1] == "journal":
        return "journal", None
    if parts[-1] == "SKILL.md" and len(parts) == 2:
        return "core", CORE_LIMIT_KB
    return "section", SECTION_LIMIT_KB


def main():
    rows = []
    for path in md_files(SKILLS):
        rel = os.path.relpath(path, SKILLS).replace(BS, "/")
        kind, limit = classify(rel)
        rows.append((rel, kind, limit, kb(path)))

    if "--list" in sys.argv:
        for rel, kind, limit, size in sorted(rows, key=lambda r: -r[3]):
            mark = "" if limit is None or size <= limit else "  ← понад %d КБ" % limit
            print("%7.1f КБ  %-8s %s%s" % (size, kind, rel, mark))
        print()

    problems = [r for r in rows if r[2] is not None and r[3] > r[2]]
    checked = len([r for r in rows if r[2] is not None])
    for rel, kind, limit, size in sorted(problems, key=lambda r: -r[3]):
        what = "ЯДРО" if kind == "core" else "СЕКЦІЯ"
        print("  %s ПОНАД ЛІМІТ %s — %.2f КБ (ліміт %d): не влазить в один Read" % (what, rel, size, limit))
    print()
    # Порожній вибір — не «чисто»: хибний шлях до тек або cwd без .claude/skills дав би
    # «0 passed (0)» з exit 0, і verdict.sh назвав би це зеленим.
    cores = len([r for r in rows if r[1] == "core"])
    if cores == 0:
        print("  НЕ ЗНАЙДЕНО жодного ядра SKILL.md у %s — гейт нічого не перевірив" % SKILLS)
        print("1 failed | 0 passed (%d)" % checked)
        return 1
    if problems:
        print("%d failed | %d passed (%d)" % (len(problems), checked - len(problems), checked))
        return 1
    print("%d passed (%d)" % (checked, checked))
    return 0


if __name__ == "__main__":
    sys.exit(main())
