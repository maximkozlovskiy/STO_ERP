"""Спільне для hook'ів Claude Code (scripts/hooks/*.py): читання payload'а і транскрипту.

Hook запускається окремим процесом (`python scripts/hooks/<hook>.py`), тож цей модуль лежить
поруч і імпортується як `from _common import …` (тека скрипта — перша в sys.path).
"""
import io
import json
import sys


def setup_stdio():
    """stdout/stderr у UTF-8: на цій машині консольне кодування cp1251, а повідомлення hook'ів
    кирилицею (stderr іде агенту як фідбек)."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def read_stdin_json():
    """Читає payload ЯК БАЙТИ і декодує UTF-8 явно. Порожній чи зіпсований stdin → {}.

    ПАСТКА (зловлена на живому прогоні). `sys.stdin.read()` декодує консольним
    кодуванням, а на цій машині воно cp1251. Платформа надсилає UTF-8, тому
    кирилиця перетворювалась на «РЈСЃРµ С‡РёСЃС‚Рѕ» — JSON лишався валідним
    (мояибаке теж валідний рядок), ключі читались, але українські регулярки по
    ньому не матчились. Наслідок: hook тихо пропускав РІВНО ті відповіді, які
    мав блокувати, і виглядав робочим — exit 0 на вердикті без доказу.
    Тому читаємо sys.stdin.buffer, не sys.stdin.
    """
    try:
        buf = getattr(sys.stdin, "buffer", None)
        raw = buf.read().decode("utf-8", "replace") if buf else sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


def iter_transcript(path, needle=None):
    """Записи транскрипту (JSONL) по одному; биті рядки пропускає. `needle` — швидкий
    відсів рядків до json.loads (транскрипт сесії буває сотні МБ)."""
    with io.open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if needle is not None and needle not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if isinstance(d, dict):
                yield d


def content_blocks(record):
    """Блоки `message.content` запису, лише якщо це список словників."""
    msg = record.get("message")
    content = msg.get("content") if isinstance(msg, dict) else None
    if not isinstance(content, list):
        return []
    return [b for b in content if isinstance(b, dict)]
