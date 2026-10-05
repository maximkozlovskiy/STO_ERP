#!/usr/bin/env python
"""Stop-hook: не дати завершити відповідь, що містить вердикт/цифри БЕЗ доказу.

НАВІЩО. Виклик `sto-claims-auditor` прописаний у CLAUDE.md, але правило тримається
лише на тому, що я його читаю. Той самий тип правила («review і tester ніколи не
паралельно») я порушив у цій же сесії. Hook робить його механічним.

ЩО РОБИТЬ. Читає транскрипт, бере ПОСЛІДНІЙ блок assistant-тексту (те, що зараз
піде користувачу). Якщо в ньому є вердикт («чисто», «0 помилок») або цифри-
твердження, а в ЦЬОМУ Ж ході не було ні виклику `sto-claims-auditor`, ні запуску
`verdict.sh`/`measure.sh` — блокує завершення й нагадує, що саме перевірити.

КОНТРАКТ (перевірено на реальному транскрипті цієї сесії):
  exit 0 — пропустити (доказ є / тверджень немає / не змогли прочитати транскрипт);
  exit 2 — заблокувати; stderr іде агенту як фідбек.

ЗАПОБІЖНИК ВІД ЦИКЛУ. Блокуємо МАКСИМУМ раз на хід: якщо у stdin приходить
`stop_hook_active: true` — пропускаємо. Якщо цього поля немає, страхуємось
власним маркером у temp-каталозі сесії.

ВАЖЛИВО: hook НЕ вирішує, чи твердження правдиве. Він лише питає «чим виміряв».
"""
import json
import io
import os
import re
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Ті самі патерни, що в audit-claims.py — свідомо, щоб hook і аудитор бачили одне й те саме.
VERDICT = re.compile(
    r"(чист[оиій]|зелен[ао]|все\s+ок|без\s+помилок|0\s+(?:помилок|падінь|проблем|вразливост)"
    r"|не\s+знайдено|немає\s+(?:багів|проблем|розбіжност)|можна\s+релізити)",
    re.I,
)
NUMBER = re.compile(
    r"\b\d[\d\s/]*\b\s*(?:тест|падін|помил|роут|файл|модул|рядк|мс|%|коміт|вразлив)", re.I
)
# Доказ: виклик аудитора АБО запуск вимірювальних скриптів у цьому ж ході.
PROOF_TOOL = re.compile(r"(sto-claims-auditor|verdict\.sh|measure\.sh|count-untyped-routes)", re.I)


def read_stdin_json():
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


def last_turn(path):
    """Повертає (текст останнього assistant-блоку, рядок із назвами інструментів ходу).

    «Хід» = записи після останнього user-повідомлення. Саме в ньому має бути доказ:
    посилання на перевірку, зроблену три години тому, нічого не підтверджує про
    цифри, названі зараз.
    """
    recs = []
    with io.open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                recs.append(json.loads(line))
            except Exception:
                continue
    # межа ходу — останній справжній user-запит
    start = 0
    for i, d in enumerate(recs):
        if d.get("type") == "user":
            start = i
    text_parts, tool_names = [], []
    for d in recs[start:]:
        content = d.get("message", {}).get("content", [])
        if not isinstance(content, list):
            continue
        for b in content:
            if b.get("type") == "text":
                text_parts.append(b.get("text") or "")
            elif b.get("type") == "tool_use":
                tool_names.append(b.get("name") or "")
                tool_names.append(json.dumps(b.get("input", {}), ensure_ascii=False))
    return "\n".join(text_parts), "\n".join(tool_names)


def main():
    data = read_stdin_json()

    # 1. Антицикл: платформний прапорець.
    if data.get("stop_hook_active"):
        return 0

    path = data.get("transcript_path") or os.environ.get("CLAUDE_TRANSCRIPT_PATH")
    if not path or not os.path.exists(path):
        # Не змогли прочитати — НЕ блокуємо. Hook не має ламати роботу через власну
        # неготовність; «невідоме» тут означає «пропустити», бо хибне блокування
        # дорожче за пропущене нагадування.
        return 0

    # 2. Антицикл-страховка: один блок на (сесія, розмір транскрипту).
    sid = str(data.get("session_id") or "nosid")
    marker = os.path.join(tempfile.gettempdir(), f"claims-hook-{sid}.last")
    try:
        size = str(os.path.getsize(path))
        if os.path.exists(marker) and io.open(marker, encoding="utf-8").read().strip() == size:
            return 0
    except Exception:
        size = ""

    try:
        text, tools = last_turn(path)
    except Exception:
        return 0

    if not text.strip():
        return 0
    if PROOF_TOOL.search(tools):          # доказ у цьому ж ході — пропускаємо
        return 0

    claims = []
    for chunk in text.split("\n"):
        s = chunk.strip(" |-*#`")
        if not (15 < len(s) < 300):
            continue
        if VERDICT.search(s) or NUMBER.search(s):
            claims.append(s)
    if not claims:
        return 0

    try:
        if size:
            io.open(marker, "w", encoding="utf-8").write(size)
    except Exception:
        pass

    sys.stderr.write(
        "СТОП: у відповіді є вердикт або цифри, але в цьому ході не запускався ні\n"
        "sto-claims-auditor, ні verdict.sh/measure.sh.\n\n"
        "Твердження, що потребують доказу (перші 5):\n"
        + "".join(f"  • {c[:160]}\n" for c in claims[:5])
        + "\nЗробіть ОДНЕ з трьох:\n"
        "  1) Agent(subagent_type=\"sto-claims-auditor\") — якщо це підсумок роботи;\n"
        "  2) прогоніть verdict.sh / measure.sh і назвіть вивід;\n"
        "  3) якщо цифра взята з раніше названого виміру — скажіть ЗВІДКИ саме,\n"
        "     або прямо напишіть, що вона не перевірена цього ходу.\n"
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
