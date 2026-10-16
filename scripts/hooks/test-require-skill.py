#!/usr/bin/env python
"""Тест PreToolUse-hook'а require-skill-before-edit.py. Запуск: python scripts/hooks/test-require-skill.py

Hook ганяється окремим процесом із реальним payload'ом і транскриптом (як його кличе
платформа) — читання коду не доводить, що він спрацює (див. test-check-claims.py).
exit 2 = заблокував правку, 0 = пропустив.
"""
import json
import os
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOK = os.path.join(ROOT, "scripts", "hooks", "require-skill-before-edit.py")
BLOCK, PASS = 2, 0

SCHEMA = "E:\\Git\\STO ERP\\packages\\database\\prisma\\schema\\07_inventory.prisma"
MIGRATION = "E:/Git/STO ERP/packages/database/prisma/migrations/20261016_x/migration.sql"
OTHER = "E:\\Git\\STO ERP\\apps\\api\\src\\modules\\calendar\\calendar.service.ts"

SKILL_CALL = {"type": "tool_use", "name": "Skill", "input": {"skill": "sto-database"}}
SKILL_READ = {
    "type": "tool_use",
    "name": "Read",
    "input": {"file_path": "E:\\Git\\STO ERP\\.claude\\skills\\sto-database\\SKILL.md"},
}
OTHER_SKILL = {"type": "tool_use", "name": "Skill", "input": {"skill": "sto-dev"}}


def transcript(blocks):
    fd, path = tempfile.mkstemp(suffix=".jsonl")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps({"type": "user", "message": {"content": "зроби міграцію"}}) + "\n")
        for b in blocks:
            f.write(json.dumps({"type": "assistant", "message": {"content": [b]}},
                               ensure_ascii=False) + "\n")
    return path


def run(tool, path, blocks):
    tp = transcript(blocks)
    payload = {"tool_name": tool, "tool_input": {"file_path": path}, "transcript_path": tp,
               "hook_event_name": "PreToolUse"}
    try:
        return subprocess.run([sys.executable, HOOK], input=json.dumps(payload).encode("utf-8"),
                              capture_output=True).returncode
    finally:
        os.remove(tp)


CASES = [
    (BLOCK, "схема без скіла", "Edit", SCHEMA, []),
    (BLOCK, "міграція без скіла (Write, прямі слеші)", "Write", MIGRATION, []),
    (BLOCK, "чужий скіл не рахується", "Edit", SCHEMA, [OTHER_SKILL]),
    (PASS, "скіл викликано", "Edit", SCHEMA, [SKILL_CALL]),
    (PASS, "SKILL.md прочитано (агент)", "Write", MIGRATION, [SKILL_READ]),
    (PASS, "інший шлях — не зона", "Edit", OTHER, []),
    (PASS, "не правка (Read схеми)", "Read", SCHEMA, []),
]


def main():
    fails = 0
    for want, label, tool, path, blocks in CASES:
        got = run(tool, path, blocks)
        ok = got == want
        fails += not ok
        print(f"{'ok  ' if ok else 'FAIL'}    очік={want} факт={got}  {label}")
    got = subprocess.run([sys.executable, HOOK], input=b"", capture_output=True).returncode
    ok = got == PASS
    fails += not ok
    print(f"{'ok  ' if ok else 'FAIL'}    очік=0 факт={got}  <порожній stdin>")
    total = len(CASES) + 1
    print(f"\n{total - fails} passed ({total})" if not fails else f"\n{fails} failed ({total})")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
