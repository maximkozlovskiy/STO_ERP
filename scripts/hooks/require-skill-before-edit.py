#!/usr/bin/env python
"""PreToolUse hook: правка «важкої» зони коду — лише після того, як прочитано її скіл.

НАВІЩО. CLAUDE.md («Автономний вибір скілів», крок 1) каже читати скіл ДО коду: зміна
`prisma/schema/*.prisma` чи міграції → `/sto-database`. Правило трималося лише на тексті:
2026-10-15/16 головний агент двічі писав міграції даних, не завантаживши `/sto-database`
(рішення власника 2026-10-16 — тримати механічно, як Stop-hook тримає вердикти).

ЯК. Для Edit/Write/MultiEdit/NotebookEdit дивиться `tool_input.file_path`. Для Bash — команду:
`prisma migrate dev|diff`, `--create-only`, скрипти-аліаси `migrate dev` (`pnpm db:migrate`,
`pnpm … migrate` пакета БД) і ЗАПИС у теку зони через `sed -i`, `>`/`>>` (зокрема heredoc),
`tee`, `cp`, `mv`. Читання (`cat`, `grep`, `sed -n`), `prisma generate`, `migrate deploy|status`
— не правка. Якщо дія в зоні з таблиці ZONES — шукає в транскрипті сесії доказ, що скіл
завантажено: виклик інструмента Skill з цим іменем АБО Read його `SKILL.md` (агенти читають
скіли файлом). Немає — exit 2, stderr іде агенту з підказкою; дію не зроблено. Є — exit 0.

Нічого не прочитати (немає транскрипту чи stdin) — НЕ блокуємо: хибне блокування дорожче.
"""
import os
import re
import shlex
import sys

sys.dont_write_bytecode = True  # без __pycache__ у scripts/hooks від імпорту _common
from _common import content_blocks, iter_transcript, read_stdin_json, setup_stdio  # noqa: E402

setup_stdio()

EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
SEPARATORS = {"&&", "||", ";", "|", "&", "(", ")", "|&", ";;"}
REDIRECTS = {">", ">>", ">|", "&>", "&>>"}
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
# `<<EOF`, `<<-EOF`, `<<'EOF'`; не here-string `<<<`.
HEREDOC = re.compile(r"(?<!<)<<-?(?!<)\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def prisma_migrate_dev(tokens):
    """`prisma migrate dev|diff`, `--create-only` та аліаси `migrate dev` у package.json
    (корінь: `db:migrate`; packages/database: `migrate`). `migrate deploy|status|reset` і
    `prisma generate` — не правка схеми/міграцій."""
    if "--create-only" in tokens:
        return True
    for i, t in enumerate(tokens[:-1]):
        if t == "prisma" and tokens[i + 1] == "migrate":
            return i + 2 < len(tokens) and tokens[i + 2] in ("dev", "diff")
    if tokens and tokens[0] in ("pnpm", "npm", "yarn"):
        return "db:migrate" in tokens or "migrate" in tokens
    return False


# Зона: (регулярка шляху для Edit/Write, регулярка шляху в команді Bash, скіл, чому,
#        перевірка простої команди Bash за токенами → True, якщо це правка зони).
# У Bash шлях буває відносним (`cd packages/database && … > prisma/migrations/…`), тож там
# достатньо `prisma/(schema|migrations)` — інших таких тек у репо немає.
ZONES = [
    (
        re.compile(r"packages[\\/]database[\\/]prisma[\\/](schema|migrations)[\\/]", re.I),
        re.compile(r"(?:^|[\\/])prisma[\\/]+(?:schema|migrations)(?:[\\/]|$)", re.I),
        "sto-database",
        "зміна схеми Prisma чи міграції",
        prisma_migrate_dev,
    ),
]


def strip_heredocs(cmd):
    """Прибирає тіла heredoc: текст листа чи коміту («… prisma migrate dev …») — не команда.
    Сам `<<EOF` лишається, тож `cat > prisma/schema/x <<EOF` і далі видно як запис."""
    out, lines, i = [], cmd.split("\n"), 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        i += 1
        for m in HEREDOC.finditer(line):
            end = m.group(2)
            while i < len(lines) and lines[i].strip() != end:
                i += 1
            i += 1  # рядок-термінатор
    return "\n".join(out)


def simple_commands(cmd):
    """Команда → прості команди (списки токенів). Лапки зберігають аргумент цілим: `-m "a > b"`
    — один токен, не перенаправлення. Не розібралось (непарні лапки) → None."""
    lex = shlex.shlex(strip_heredocs(cmd).replace("\n", " ; "), posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    lex.commenters = ""
    try:
        tokens = list(lex)
    except ValueError:
        return None
    cmds, cur = [], []
    for t in tokens + [";"]:
        if t not in SEPARATORS:
            # змінні оточення перед командою (`DATABASE_URL=… pnpm db:migrate`) — не команда
            if cur or not ASSIGNMENT.match(t):
                cur.append(t)
        elif cur:
            cmds.append(cur)
            cur = []
    return cmds


def writes_zone(tokens, path_re):
    """Проста команда пише у файл зони: перенаправлення, `tee`, `sed -i`, ціль `cp`/`mv`."""
    for i, t in enumerate(tokens[:-1]):
        if t in REDIRECTS and path_re.search(tokens[i + 1]):
            return True
    prog = os.path.basename(tokens[0])
    args = [t for t in tokens[1:] if t not in REDIRECTS]
    if prog == "tee":
        return any(path_re.search(a) for a in args if not a.startswith("-"))
    if prog == "sed":
        in_place = any(a == "--in-place" or re.match(r"^-[a-zA-Z]*i", a) for a in args)
        return in_place and any(path_re.search(a) for a in args)
    if prog in ("cp", "mv"):
        target = next((args[j + 1] for j, a in enumerate(args[:-1]) if a in ("-t", "--target-directory")), None)
        if target is None:
            plain = [a for a in args if not a.startswith("-")]
            target = plain[-1] if len(plain) >= 2 else None
        return bool(target) and bool(path_re.search(target))
    return False


def bash_hits_zone(cmd, zone):
    _, path_re, _, _, command_check = zone
    cmds = simple_commands(cmd)
    if cmds is None:
        # Не розібрали — грубо по тексту: команда міграції чи перенаправлення в теку зони.
        flat = strip_heredocs(cmd)
        return bool(
            re.search(r"\bprisma\s+migrate\s+(?:dev|diff)\b|--create-only", flat)
            or re.search(r">>?\s*['\"]?[^\s'\"]*prisma[\\/]+(?:schema|migrations)[\\/]", flat)
        )
    return any(command_check(t) or writes_zone(t, path_re) for t in cmds)


def skill_loaded(transcript, skill):
    """Скіл завантажено в сесії: Skill(skill=…) або Read …/skills/<skill>/SKILL.md."""
    read_re = re.compile(r"skills[\\/]+" + re.escape(skill) + r"[\\/]+SKILL\.md", re.I)
    try:
        for d in iter_transcript(transcript, needle=skill):
            for b in content_blocks(d):
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
    tool = data.get("tool_name")
    inp = data.get("tool_input") or {}
    if tool in EDIT_TOOLS:
        path = str(inp.get("file_path") or inp.get("notebook_path") or "")
        zone = next((z for z in ZONES if z[0].search(path)), None)
        what = os.path.basename(path)
    elif tool == "Bash":
        cmd = str(inp.get("command") or "")
        zone = next((z for z in ZONES if bash_hits_zone(cmd, z)), None)
        what = "Bash: " + cmd.strip().splitlines()[0][:80] if cmd.strip() else "Bash"
    else:
        return 0
    if not zone:
        return 0
    transcript = data.get("transcript_path") or os.environ.get("CLAUDE_TRANSCRIPT_PATH")
    if not transcript or not os.path.exists(transcript):
        return 0
    skill, why = zone[2], zone[3]
    if skill_loaded(transcript, skill):
        return 0
    sys.stderr.write(
        f"СТОП: {why} ({what}) — спершу скіл /{skill} (CLAUDE.md, крок 1).\n"
        f"Завантаж його: Skill(skill=\"{skill}\") або Read .claude/skills/{skill}/SKILL.md,\n"
        "потім повтори дію.\n"
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
