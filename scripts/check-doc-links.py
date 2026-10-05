#!/usr/bin/env python
"""Перевіряє, що внутрішні посилання між .md-документами ведуть на існуючі файли.

НАВІЩО. 2026-10-05 виявилось, що 14 із 68 посилань БИТІ, і жило це довго:
(68 — область САМОГО цього скрипта: всі git-tracked .md, крім .claude/skills/.
Спершу я назвав «66» — то була цифра з ad-hoc bash-циклу по docs/*.md + MemoryManual,
тобто ІНША область. Цифра без названої області неперевірювана: аудит зловив саме це.)
`docs/ARCHITECTURE.md` (таблиця «дос'є агрегатів», 13 рядків) посилався на
`../objects/<entity>.md`, хоча сам лежить у `docs/` — тобто шлях вів у
`<корінь>/objects/`, якого не існує. Ще одне посилання вело на `employee.md`,
дос'є якого просто не написали.

Чому не ловилось: Markdown не валідується ні tsc, ні eslint, а в GitHub-рендері
битий лінк виглядає як звичайний текст-посилання. Помітно стає лише коли клікнеш.

Вивід у формі, яку розпізнає scripts/verdict.sh.
"""
import io
import os
import re
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Лише .md-цілі: посилання на .ts/.tsx/.prisma перевіряються окремо (їх шлях
# часто відносний до кореня репо, а не до документа — інша семантика).
LINK = re.compile(r"\]\(([^)#]+\.md)(#[^)]*)?\)")


def tracked_md():
    out = subprocess.run(
        ["git", "ls-files", "*.md"], capture_output=True, text=True, encoding="utf-8"
    ).stdout
    return [f for f in out.splitlines() if f.strip()]


def main():
    broken, total = [], 0
    for f in tracked_md():
        # Скіли містять regex-фрагменти виду ](...) у прикладах — не документація.
        if f.startswith(".claude/skills/"):
            continue
        try:
            s = io.open(f, encoding="utf-8").read()
        except OSError:
            continue
        base = os.path.dirname(f)
        for m in LINK.finditer(s):
            target = m.group(1)
            if target.startswith(("http://", "https://")):
                continue
            total += 1
            if not os.path.isfile(os.path.normpath(os.path.join(base, target))):
                broken.append((f, target))

    for f, t in broken:
        print("  BROKEN %s -> %s" % (f, t))
    print()
    if broken:
        print("%d failed | %d passed (%d)" % (len(broken), total - len(broken), total))
        return 1
    print("%d passed (%d)" % (total, total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
