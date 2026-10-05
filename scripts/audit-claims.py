#!/usr/bin/env python
"""Витягує з транскрипту сесії МОЇ твердження, що потребують доказу.

НАВІЩО. Агент-перевіряльник, якому я САМ передаю список тверджень, успадковує
мою сліпу пляму: якщо я не помітив, що твердження неперевірене, я не віддам
його на перевірку. Усі чотири помилки аудиту 2026-10 були саме такі — я ВІРИВ
у твердження. Тому джерело має бути НЕ моя доповідь, а мій ВЛАСНИЙ вивід.

Скрипт читає .jsonl транскрипт (не вміст контексту) і дістає assistant-текст,
що містить вердикт або цифру. Далі агент перевіряє кожне твердження ІНСТРУМЕНТОМ.

Детектор свідомо ГРУБИЙ: краще зайве твердження на перевірку, ніж пропущене.
Фільтрувати хибні спрацювання — робота агента, не регулярки (саме надто
«розумна» регулярка сім разів дала хибну цифру в цьому проєкті).

ВИКОРИСТАННЯ
  python scripts/audit-claims.py <transcript.jsonl> [--last N] [--since-turn K]
"""
import json
import io
import re
import sys

# Windows-консоль за замовчуванням cp1251 і падає на «≠», «→» тощо. Ця пастка вже
# зривала скрипти у цьому проєкті — тому примусово UTF-8 на виході.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from collections import OrderedDict

# Вердикти: слова, якими я підсумовую стан. Кожне потребує виводу інструмента.
VERDICT = re.compile(
    r"(чист[оиій]|зелен[ао]|все\s+ок|без\s+помилок|0\s+(?:помилок|падінь|проблем|вразливост)"
    r"|passed|не\s+знайдено|немає\s+(?:багів|проблем|розбіжност))",
    re.I,
)
# Цифри у контексті, де вони щось СТВЕРДЖУЮТЬ (а не просто номер рядка/версія).
NUMBER = re.compile(
    r"\b\d[\d\s/]*\b\s*(?:тест|падін|помил|роут|файл|модул|рядк|мс|ms|%|разів|коміт|вразлив)",
    re.I,
)
# Порівняння «було → стало» — класичне місце, де цифра бралась з голови.
DELTA = re.compile(r"\d+\s*(?:→|->|vs\.?|проти)\s*\d+")

# Маркери, що доказ УЖЕ названий у тому ж тексті → нижчий пріоритет.
HAS_PROOF = re.compile(
    r"(verdict\.sh|measure\.sh|--list|EXPLAIN|мутаці|відкотив|перевірив|exit=|git diff|curl )",
    re.I,
)


def blocks(path, last=None, since=None):
    out = []
    with io.open(path, encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f):
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("type") != "assistant":
                continue
            content = d.get("message", {}).get("content", [])
            if not isinstance(content, list):
                continue
            for b in content:
                if b.get("type") == "text":
                    t = (b.get("text") or "").strip()
                    if len(t) > 60:
                        out.append((i, t))
    if since is not None:
        out = [x for x in out if x[0] >= since]
    if last:
        out = out[-last:]
    return out


def sentences(text):
    # Розбиваємо по рядках і реченнях: твердження зазвичай живе в одному рядку
    # таблиці або в одному реченні.
    for chunk in text.split("\n"):
        chunk = chunk.strip(" |-*#`")
        if not chunk:
            continue
        for s in re.split(r"(?<=[.!?;])\s+", chunk):
            s = s.strip()
            if 15 < len(s) < 400:
                yield s


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    path = sys.argv[1]
    last = None
    since = None
    if "--last" in sys.argv:
        last = int(sys.argv[sys.argv.index("--last") + 1])
    if "--since-turn" in sys.argv:
        since = int(sys.argv[sys.argv.index("--since-turn") + 1])

    found = OrderedDict()
    for idx, text in blocks(path, last, since):
        proof_near = bool(HAS_PROOF.search(text))
        for s in sentences(text):
            kind = None
            if VERDICT.search(s):
                kind = "ВЕРДИКТ"
            elif NUMBER.search(s) or DELTA.search(s):
                kind = "ЦИФРА"
            if not kind:
                continue
            key = s[:120]
            if key in found:
                continue
            found[key] = (kind, idx, proof_near)

    if not found:
        print("Тверджень, що потребують доказу, не знайдено.")
        return 0

    # Спершу ті, де доказ НЕ названий поблизу — вони найризикованіші.
    ordered = sorted(found.items(), key=lambda kv: (kv[1][2], kv[1][0]))
    print(f"Знайдено {len(ordered)} тверджень. Спершу — БЕЗ названого доказу:\n")
    for s, (kind, idx, proof) in ordered:
        mark = "  " if proof else "!!"
        print(f"{mark} [{kind}] (рядок {idx}) {s}")
    print(
        "\n!! = доказ не названий у тому ж повідомленні → перевіряти першим.\n"
        "Перевірка: для вердикту — scripts/verdict.sh; для цифри — scripts/measure.sh\n"
        "або точний інструмент (playwright --list, EXPLAIN, count-untyped-routes.py)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
