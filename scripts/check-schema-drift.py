#!/usr/bin/env python3
"""Сторож дрейфу схеми: чи дають МІГРАЦІЇ ту саму базу, яку описує schema.prisma.

Навіщо. 2026-10-08 CI уперше застосував міграції до порожньої бази — і seed упав: у схемі були
колонки `organisation_settings.recalcPlannedHoursFromLines` і `calendar_slots.parentSlotId`, яких
не створювала жодна міграція. У довгоживучих dev-базах вони з'явились через `prisma db push`, тож
локально все працювало, а чиста інсталяція була зламана. Тести цього не бачили: unit мокають
Prisma, integration ходять у dev-базу.

Що робить. Просить у Prisma різницю «база з DATABASE_URL → schema.prisma» і валить прогін, якщо в
ній є щось, крім відомого шуму. Запускати ОДРАЗУ після `prisma migrate deploy` на базі, яку
щойно створено з нуля (у CI — job integration-tests).

Відомий шум (не дрейф):
  • DROP INDEX — індекси, створені вручну в міграціях (GIN/trgm, partial unique), яких
    schema.prisma не вміє виразити; їх окремо стереже schema-integrity.integration.spec.ts;
  • перестворення FK `…_currencyId_fkey` та `idempotency_keys_orgId_fkey` — відмінність в
    `ON DELETE`, наявна і в dev-базі, і в чистій; окремий борг, не блокер запуску.

Вихід: 0 — дрейфу немає; 1 — є (перелік у stdout); 2 — Prisma не відпрацювала.
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PKG = os.path.join(ROOT, "packages", "database")

NOISE = [
    re.compile(r'^DROP INDEX "'),
    re.compile(r'^ALTER TABLE "\w+" DROP CONSTRAINT "\w+_(currencyId|orgId)_fkey";$'),
    re.compile(r'^ALTER TABLE "\w+" ADD CONSTRAINT "\w+_currencyId_fkey" FOREIGN KEY'),
    re.compile(r'^ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_orgId_fkey" FOREIGN KEY'),
]


def statements(sql):
    """SQL-скрипт → окремі оператори (без коментарів і порожніх рядків)."""
    lines = [ln for ln in sql.splitlines() if ln.strip() and not ln.lstrip().startswith("--")]
    out, buf = [], []
    for ln in lines:
        buf.append(ln.strip())
        if ln.rstrip().endswith(";"):
            out.append(" ".join(buf))
            buf = []
    if buf:
        out.append(" ".join(buf))
    return out


def drift(sql):
    return [s for s in statements(sql) if not any(p.search(s) for p in NOISE)]


def main():
    if "--self-test" in sys.argv:
        sample = "\n".join(
            [
                "-- DropIndex",
                'DROP INDEX "goods_name_trgm_idx";',
                'ALTER TABLE "invoices" DROP CONSTRAINT "invoices_currencyId_fkey";',
                'ALTER TABLE "invoices" ADD CONSTRAINT "invoices_currencyId_fkey" FOREIGN KEY ("currencyId")',
                '  REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;',
                'ALTER TABLE "organisation_settings" ADD COLUMN "x" BOOLEAN NOT NULL DEFAULT true;',
                'CREATE INDEX "a_idx" ON "a"("b");',
            ]
        )
        found = drift(sample)
        ok = len(found) == 2 and "ADD COLUMN" in found[0] and found[1].startswith("CREATE INDEX")
        print("1 passed (1)" if ok else "1 failed | 0 passed (1)\n  " + "\n  ".join(found))
        return 0 if ok else 1

    if not os.environ.get("DATABASE_URL"):
        print("DATABASE_URL не задано — сторож дрейфу потребує базу, до якої щойно застосовано міграції")
        return 2
    cmd = "npx prisma migrate diff --from-config-datasource --to-schema prisma/schema --script"
    proc = subprocess.run(cmd, cwd=DB_PKG, shell=True, capture_output=True)
    sql = proc.stdout.decode("utf-8", "replace")
    if proc.returncode != 0:
        print("prisma migrate diff завершився з помилкою:\n" + proc.stderr.decode("utf-8", "replace")[-2000:])
        return 2
    found = drift(sql)
    if found:
        print("ДРЕЙФ СХЕМИ: schema.prisma описує те, чого міграції не створюють.")
        print("Додайте міграцію (не `db push`) — інакше чиста інсталяція не запуститься:\n")
        for s in found:
            print("  " + s[:300])
        print("\n%d failed | 0 passed (%d)" % (len(found), len(found)))
        return 1
    print("1 passed (1)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
