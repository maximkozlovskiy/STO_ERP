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


def run(tool, arg, blocks):
    """arg — file_path для Edit/Write/Read, command для Bash."""
    tp = transcript(blocks)
    tool_input = {"command": arg} if tool == "Bash" else {"file_path": arg}
    payload = {"tool_name": tool, "tool_input": tool_input, "transcript_path": tp,
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
    # ── Bash: створення міграції й запис у теку зони — та сама вимога скіла.
    (BLOCK, "Bash: prisma migrate dev", "Bash",
     "cd packages/database && npx prisma migrate dev --name add_x", []),
    (BLOCK, "Bash: prisma migrate diff", "Bash",
     "pnpm --filter @sto/database exec prisma migrate diff --from-schema-datasource "
     "prisma/schema --to-schema-datamodel prisma/schema --script", []),
    (BLOCK, "Bash: --create-only", "Bash", "npx prisma migrate dev --create-only --name y", []),
    (BLOCK, "Bash: аліас pnpm db:migrate зі змінною оточення", "Bash",
     "DATABASE_URL=postgresql://x pnpm db:migrate", []),
    (BLOCK, "Bash: аліас migrate пакета БД", "Bash", "pnpm --filter @sto/database migrate", []),
    (BLOCK, "Bash: sed -i у схемі", "Bash",
     "sed -i 's/Int/BigInt/' packages/database/prisma/schema/07_inventory.prisma", []),
    (BLOCK, "Bash: >> у схему", "Bash",
     'echo "model X {}" >> "packages/database/prisma/schema/07_inventory.prisma"', []),
    (BLOCK, "Bash: heredoc у міграцію (відносний шлях)", "Bash",
     "cd packages/database && cat > prisma/migrations/20261017_x/migration.sql <<'EOF'\n"
     "ALTER TABLE \"Good\" ADD COLUMN \"x\" INT;\nEOF", []),
    (BLOCK, "Bash: tee -a у схему", "Bash",
     "printf 'x' | tee -a packages/database/prisma/schema/a.prisma > /dev/null", []),
    (BLOCK, "Bash: cp у теку міграцій", "Bash",
     "cp /tmp/m.sql packages/database/prisma/migrations/20261017_x/migration.sql", []),
    (BLOCK, "Bash: mv у теку схеми", "Bash", "mv /tmp/a.prisma packages/database/prisma/schema/", []),
    (PASS, "Bash: міграція зі скілом", "Bash", "npx prisma migrate dev --name z", [SKILL_CALL]),
    (PASS, "Bash: запис зі скілом (SKILL.md прочитано)", "Bash",
     "sed -i 's/a/b/' packages/database/prisma/schema/a.prisma", [SKILL_READ]),
    (PASS, "Bash: prisma generate", "Bash", "pnpm --filter @sto/database exec prisma generate", []),
    (PASS, "Bash: migrate deploy / status", "Bash",
     "npx prisma migrate deploy && npx prisma migrate status", []),
    (PASS, "Bash: читання схеми (cat, sed -n, grep у /tmp)", "Bash",
     "cat packages/database/prisma/schema/07_inventory.prisma; "
     "sed -n '1,40p' packages/database/prisma/schema/07_inventory.prisma; "
     "grep -rn model packages/database/prisma/schema/ > /tmp/models.txt", []),
    (PASS, "Bash: cp ЗІ схеми назовні", "Bash", "cp packages/database/prisma/schema/a.prisma /tmp/", []),
    (PASS, "Bash: текст коміту (лапки)", "Bash",
     'git commit -m "docs: prisma migrate dev > prisma/schema/x — лише з /sto-database"', []),
    (PASS, "Bash: тіло heredoc коміту", "Bash",
     "git commit -F - <<'EOF'\nfix: run prisma migrate dev --create-only\n"
     "echo x > packages/database/prisma/schema/a.prisma\nEOF", []),
    (PASS, "Bash: інший шлях", "Bash", "sed -i 's/a/b/' apps/api/src/main.ts", []),
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
