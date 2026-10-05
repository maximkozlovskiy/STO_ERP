#!/usr/bin/env python
"""Тест Stop-hook'а check-claims-verified.py. Запуск: python scripts/hooks/test-check-claims.py

НАВІЩО ОКРЕМИЙ ТЕСТ. Hook тричі ламався так, що ВИГЛЯДАВ робочим:
  1. `sys.stdin.read()` декодував cp1251 → кирилиця не матчилась, exit 0 на вердикті;
  2. `\b` у генераторі патча став літеральним backspace (\x08) у RATIO;
  3. те саме у DATEISH → дата 05/10/2026 блокувалась як пропорція.
Жодне з трьох не видно ні в `grep`, ні в `py_compile`, ні очима в редакторі —
backspace не має видимого представлення. Тому поведінка перевіряється ЗАПУСКОМ
процесу з реальним payload'ом, а не читанням коду.

Тест ганяє hook як окремий процес (саме так його кличе платформа) і порівнює
exit code: 2 = заблокував, 0 = пропустив.
"""
import io
import json
import os
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOK = os.path.join(ROOT, "scripts", "hooks", "check-claims-verified.py")

BLOCK, PASS = 2, 0

# ── Поведінка: що блокувати, а що ні.
MSG_CASES = [
    # вердикт або цифра БЕЗ доказу → блок
    (BLOCK, "Усе чисто — 3118/3118 тестів, 0 помилок.", {}),
    (BLOCK, "Матриця 7/7, мутація підтвердила блокування.", {}),
    (BLOCK, "Закрито 51/137 пунктів боргу за цю сесію.", {}),
    (BLOCK, "Прогін дав 309/5/12 — перший повний після холодного старту.", {}),
    (BLOCK, "E2E чистий, падінь немає.", {}),
    # доказ у цьому ж ході → пропуск
    (PASS, "Усе чисто — 3118/3118 тестів, 0 помилок.",
     {"tool_use_ids": ["bash scripts/verdict.sh --file /tmp/x.log"]}),
    (PASS, "Матриця 7/7 — перевірено measure.sh.",
     {"tool_use_ids": ["bash scripts/measure.sh tests"]}),
    (PASS, "Цифри звірив sto-claims-auditor перед звітом.",
     {"tool_use_ids": ["Agent sto-claims-auditor"]}),
    # проза без тверджень → пропуск
    (PASS, "Додав коментар у hook про причину вибору байтового читання.", {}),
    (PASS, "Переніс логіку у apps/api/src/common/utils/money.ts.", {}),
    # ДАТИ — за формою пропорція, але не твердження → пропуск
    (PASS, "Оновив запис від 05/10/2026 у документації проєкту.", {}),
    (PASS, "Дата у форматі 05.10.2026 теж не твердження.", {}),
    (PASS, "Запис від 2026-10-05 у довіднику пасток.", {}),
    # дата І пропорція разом → блок (пропорція лишається твердженням)
    (BLOCK, "Матриця 7/7 станом на 05/10/2026 — і пропорція, і дата.", {}),
    # антицикл
    (PASS, "Усе чисто — 0 помилок, 3118 тестів.", {"stop_hook_active": True}),
]


def clear_markers():
    d = tempfile.gettempdir()
    for f in os.listdir(d):
        if f.startswith("claims-hook-"):
            try:
                os.remove(os.path.join(d, f))
            except OSError:
                pass


def run(payload):
    """Запускає hook процесом і віддає exit code. Payload — байтами у UTF-8."""
    clear_markers()
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return subprocess.run(
        [sys.executable, HOOK], input=raw, capture_output=True
    ).returncode


def main():
    bad = []
    for i, (want, msg, extra) in enumerate(MSG_CASES):
        payload = {"session_id": "t%d" % i, "hook_event_name": "Stop",
                   "last_assistant_message": msg}
        payload.update(extra)
        got = run(payload)
        ok = got == want
        if not ok:
            bad.append((want, got, msg))
        print("%-7s очік=%d факт=%d  %s" % ("ok" if ok else "ПОМИЛКА", want, got, msg[:58]))

    # Порожній stdin — hook не має падати і не має блокувати.
    got = subprocess.run([sys.executable, HOOK], input=b"", capture_output=True).returncode
    ok = got == PASS
    if not ok:
        bad.append((PASS, got, "<порожній stdin>"))
    print("%-7s очік=%d факт=%d  <порожній stdin>" % ("ok" if ok else "ПОМИЛКА", PASS, got))

    # Транскрипт-файл: той самий текст із доказом і без нього.
    d = tempfile.mkdtemp()
    base = [
        {"type": "user", "message": {"content": [{"type": "text", "text": "перевір"}]}},
        {"type": "assistant", "message": {"content": [
            {"type": "text", "text": "Усе чисто — 3118/3118 тестів, 0 помилок."}]}},
    ]
    proof = base + [{"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Bash",
         "input": {"command": "bash scripts/verdict.sh --file /tmp/x.log"}}]}}]
    for name, recs, want in (("транскрипт без доказу", base, BLOCK),
                             ("транскрипт із доказом", proof, PASS)):
        fp = os.path.join(d, name.replace(" ", "_") + ".jsonl")
        with io.open(fp, "w", encoding="utf-8", newline="\n") as f:
            for r in recs:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        got = run({"session_id": name, "hook_event_name": "Stop", "transcript_path": fp})
        ok = got == want
        if not ok:
            bad.append((want, got, name))
        print("%-7s очік=%d факт=%d  %s" % ("ok" if ok else "ПОМИЛКА", want, got, name))

    # Підсумок у ФОРМІ, яку розпізнає scripts/verdict.sh — інакше він каже
    # «НЕ РОЗПІЗНАНО» (і має рацію: невідоме ≠ чисто). Власний формат вердикту
    # означав би, що результат цього тесту не можна перевірити інструментом,
    # тобто він випав би з того самого правила, яке hook і стереже.
    total = len(MSG_CASES) + 3
    print()
    if bad:
        print("%d failed | %d passed (%d)" % (len(bad), total - len(bad), total))
        return 1
    print("%d passed (%d)" % (total, total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
