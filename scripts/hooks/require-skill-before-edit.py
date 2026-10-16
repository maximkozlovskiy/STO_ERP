#!/usr/bin/env python
"""PreToolUse hook: правка «важкої» зони коду — лише після того, як прочитано її скіл.

НАВІЩО. CLAUDE.md («Автономний вибір скілів», крок 1) каже читати скіл ДО коду: зміна
`prisma/schema/*.prisma` чи міграції → `/sto-database`. Правило трималося лише на тексті:
2026-10-15/16 головний агент двічі писав міграції даних, не завантаживши `/sto-database`
(рішення власника 2026-10-16 — тримати механічно, як Stop-hook тримає вердикти).

ЯК. Для Edit/Write/MultiEdit/NotebookEdit дивиться `tool_input.file_path`. Якщо шлях у зоні з
таблиці ZONES — шукає в транскрипті сесії доказ, що скіл завантажено: виклик інструмента
Skill з цим іменем АБО Read його `SKILL.md` (агенти читають скіли файлом). Немає — exit 2,
stderr іде агенту з підказкою; правку не зроблено. Є — exit 0.

Нічого не прочитати (немає транскрипту чи stdin) — НЕ блокуємо: хибне блокування дорожче.
"""
import io
import json
import os
import re
import sys

if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# (регулярка шляху, скіл, чому)
ZONES = [
    (
        re.compile(r"packages[\\/]database[\\/]prisma[\\/](schema|migrations)[\\/]", re.I),
        "sto-database",
        "зміна схеми Prisma чи міграції",
    ),
]
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}


def read_stdin_json():
    try:
        buf = getattr(sys.stdin, "buffer", None)
        raw = buf.read().decode("utf-8", "replace") if buf else sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


def skill_loaded(transcript, skill):
    """Скіл завантажено в сесії: Skill(skill=…) або Read …/skills/<skill>/SKILL.md."""
    read_re = re.compile(r"skills[\\/]+" + re.escape(skill) + r"[\\/]+SKILL\.md", re.I)
    try:
        with io.open(transcript, encoding="utf-8", errors="replace") as f:
            for line in f:
                if skill not in line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                content = d.get("message", {}).get("content", [])
                if not isinstance(content, list):
                    continue
                for b in content:
                    if b.get("type") != "tool_use":
                        continue
                    inp = b.get("input") or {}
                    name = b.get("name") or ""
                    if name == "Skill" and str(inp.get("skill", "")).lstrip("/") == skill:
                        return True
                    if name == "Read" and read_re.search(str(inp.get("file_path", ""))):
                        return True
    except Exception:
        return True  # не змогли прочитати — не блокуємо
    return False


def main():
    data = read_stdin_json()
    if data.get("tool_name") not in EDIT_TOOLS:
        return 0
    inp = data.get("tool_input") or {}
    path = str(inp.get("file_path") or inp.get("notebook_path") or "")
    zone = next((z for z in ZONES if z[0].search(path)), None)
    if not zone:
        return 0
    transcript = data.get("transcript_path") or os.environ.get("CLAUDE_TRANSCRIPT_PATH")
    if not transcript or not os.path.exists(transcript):
        return 0
    _, skill, why = zone
    if skill_loaded(transcript, skill):
        return 0
    sys.stderr.write(
        f"СТОП: {why} ({os.path.basename(path)}) — спершу скіл /{skill} (CLAUDE.md, крок 1).\n"
        f"Завантаж його: Skill(skill=\"{skill}\") або Read .claude/skills/{skill}/SKILL.md,\n"
        "потім повтори правку.\n"
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
