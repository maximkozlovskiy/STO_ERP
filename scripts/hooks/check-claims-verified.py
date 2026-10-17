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
import io
import json
import os
import re
import sys
import tempfile

sys.dont_write_bytecode = True  # без __pycache__ у scripts/hooks від імпорту _common
from _common import content_blocks, iter_transcript, read_stdin_json, setup_stdio  # noqa: E402

NL = chr(10)  # явно, щоб не залежати від escape-послідовностей у генераторах

setup_stdio()

# Ті самі патерни, що в audit-claims.py — свідомо, щоб hook і аудитор бачили одне й те саме.
VERDICT = re.compile(
    r"(чист[оиій]|зелен[ао]|все\s+ок|без\s+помилок|0\s+(?:помилок|падінь|проблем|вразливост)"
    r"|не\s+знайдено|немає\s+(?:багів|проблем|розбіжност)|можна\s+релізити)",
    re.I,
)
NUMBER = re.compile(
    r"\b\d[\d\s/]*\b\s*(?:тест|падін|помил|роут|файл|модул|рядк|мс|%|коміт|вразлив)", re.I
)
# ГОЛА ПРОПОРЦІЯ без іменника: «7/7», «51/137», «309/5/12». NUMBER її не бачить,
# бо вимагає слово-одиницю після цифр. А саме на цій формі аудитор зловив мене
# двічі («51 із 137» при рухомій базі), і нею ж я підсумовую матриці тестів.
# Дату «05/10/2026» відсікає обмеження на 5 цифр у компоненті + заборона ще однієї
# групи цифр одразу після — рік у знаменнику пропорції тестів не буває.
RATIO = re.compile(
    r"(?<![\d/.-])"
    r"\d{1,5}\s*/\s*\d{1,5}"
    r"(?:\s*/\s*\d{1,5})?"
    r"(?![\d]|\s*[/.-]\s*\d)"
)
# Дата «05/10/2026» або «05.10.2026» за формою теж пропорція. Окремий патерн
# простіший і надійніший за спробу відрізнити їх однією регуляркою: щоразу,
# коли я ускладнював RATIO, зʼявлявся новий кутовий випадок (рік то з'їдався
# третім компонентом, то лишався поза матчем).
DATEISH = re.compile(r"\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b")
# Доказ: виклик аудитора АБО запуск вимірювальних скриптів у цьому ж ході.
PROOF_TOOL = re.compile(r"(sto-claims-auditor|verdict\.sh|measure\.sh|count-untyped-routes)", re.I)
# Підсумок БЛОКУ чи готовність до релізу — тут verdict.sh замало, потрібен саме аудитор
# (CLAUDE.md, «Вердикт і цифри», п.3). Рішення власника 2026-10-16: за два дні аудитор
# запускався двічі на ~10 блоків, бо hook пропускав будь-який verdict.sh у ході.
RELEASE = re.compile(
    r"(можна\s+релізити|готов[оаі]\s+до\s+релізу|(?:блок|фіч[ау]|роботу)\s+(?:завершено|закрито))",
    re.I,
)
AUDITOR = re.compile(r"sto-claims-auditor", re.I)
# Цитата — не твердження: «блок завершено» в лапках чи бектиках, коли я ОПИСУЮ правило, а не
# підсумовую блок (рішення власника 2026-10-16 — hook блокував власний опис правила). Цитати
# знімаються ОДИН раз з рядка перед усіма перевірками (вердикт, реліз, цифри, пропорції):
# раніше цифри перевірялись по рядку з цитатами, і «340 passed» у лапках теж блокувало.
QUOTED = re.compile(r"«[^«»\n]*»|\"[^\"\n]*\"|“[^”\n]*”|`[^`\n]*`")


def strip_quotes(s):
    """Знімає цитати зсередини назовні: «правило «блок завершено» описано» — вкладені ялинки
    інакше закривались на першій «»» і хвіст цитати виглядав твердженням."""
    prev = None
    while prev != s:
        prev, s = s, QUOTED.sub(" ", s)
    return s


def is_user_prompt(record):
    """Запис `user` — справжній запит людини, а не результат інструмента чи службовий звіт."""
    if record.get("isMeta"):
        return False
    return not any(b.get("type") == "tool_result" for b in content_blocks(record))


def last_turn(path):
    """Повертає (текст останнього assistant-блоку, рядок із назвами інструментів ходу).

    «Хід» = записи після останнього user-повідомлення. Саме в ньому має бути доказ:
    посилання на перевірку, зроблену три години тому, нічого не підтверджує про
    цифри, названі зараз.

    Текст і інструменти — ЛИШЕ з записів `type: "assistant"` головної сесії. Звіт субагента
    (hand-back) лежить у транскрипті двічі: записом `type: "user"` (`isMeta`, `origin.kind:
    "peer"`, текст рядком) і записом `type: "api-request-blob"` з `message.role: "user"` та
    блоками `{"type": "text"}` — `<system-reminder>…<agent-message …>`. Другий межею ходу не
    є, а його text-блоки йшли в «мою відповідь»: хук блокував на рядках зі звітів агентів
    (сесія 771d064f, 2026-10-17: 6 з 76 блокувань — на тексті api-request-blob).
    """
    recs = list(iter_transcript(path))
    # межа ходу — останній справжній user-запит. Результат інструмента (`tool_result`) і звіт
    # субагента (`isMeta`) теж мають `type: "user"`, але межею ходу не є: інакше доказ
    # (verdict.sh, виклик sto-claims-auditor) до останнього результату інструмента випадав би
    # з ходу, і hook блокував би відповідь, що його має.
    start = 0
    for i, d in enumerate(recs):
        if d.get("type") == "user" and is_user_prompt(d):
            start = i
    text_parts, tool_names = [], []
    for d in recs[start:]:
        if d.get("type") != "assistant" or d.get("isSidechain"):
            continue
        for b in content_blocks(d):
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

    # ДВА ДЖЕРЕЛА, бо контракт stdin задокументований неповно (issue #19947 про
    # SubagentStop; `stop_hook_active` згадується як «частково документоване»).
    # Тому не покладаємось на одну форму: якщо платформа дає `last_assistant_message`
    # і/або `tool_use_ids` — беремо їх; якщо лише `transcript_path` — читаємо файл.
    # Перевірено: без цієї гілки payload із одним `last_assistant_message` тихо
    # проходив, тобто запобіжник не спрацьовував саме там, де мав.
    direct_msg = data.get("last_assistant_message") or ""
    direct_tools = json.dumps(
        [data.get("tool_use_ids") or [], data.get("background_tasks") or []], ensure_ascii=False
    )

    path = data.get("transcript_path") or os.environ.get("CLAUDE_TRANSCRIPT_PATH")
    have_file = bool(path) and os.path.exists(path)
    if not have_file and not direct_msg.strip():
        # Нічого читати — НЕ блокуємо. Hook не має ламати роботу через власну
        # неготовність; «невідоме» тут означає «пропустити», бо хибне блокування
        # дорожче за пропущене нагадування.
        return 0

    # 2. Антицикл-страховка: один блок на (сесія, розмір транскрипту).
    sid = str(data.get("session_id") or "nosid")
    marker = os.path.join(tempfile.gettempdir(), f"claims-hook-{sid}.last")
    try:
        size = str(os.path.getsize(path)) if have_file else str(len(direct_msg))
        if os.path.exists(marker) and io.open(marker, encoding="utf-8").read().strip() == size:
            return 0
    except Exception:
        size = ""

    text, tools = "", ""
    if have_file:
        try:
            text, tools = last_turn(path)
        except Exception:
            pass
    # stdin-дані ДОДАЮТЬСЯ до прочитаного з файлу, а не заміщують: якщо платформа дала
    # лише повідомлення, воно все одно перевіриться.
    text = NL.join([text, direct_msg]).strip()
    tools = NL.join([tools, direct_tools])

    if not text.strip():
        return 0

    def block(header, lines, tail):
        """Блокує завершення: маркер антициклу + stderr агенту + exit 2."""
        try:
            if size:
                io.open(marker, "w", encoding="utf-8").write(size)
        except Exception:
            pass
        sys.stderr.write(header + "".join(f"  • {c[:160]}\n" for c in lines) + tail)
        return 2

    # (рядок для звіту, той самий рядок без цитат) — цитати знімаються ОДИН раз, і всі
    # перевірки нижче йдуть по рядку без них.
    lines = [(s, strip_quotes(s)) for s in (c.strip(" |-*#`") for c in text.split(NL))]

    release = [s for s, q in lines if RELEASE.search(q)]
    if release and not AUDITOR.search(tools):
        return block(
            "СТОП: відповідь підсумовує блок або каже про готовність до релізу, але в цьому\n"
            "ході не запускався sto-claims-auditor (verdict.sh тут замало — CLAUDE.md, п.3):\n",
            release[:3],
            "\nЗапустіть Agent(subagent_type=\"sto-claims-auditor\") і зведіть звіт за ним,\n"
            "або приберіть формулювання про завершення, якщо блок ще не закрито.\n",
        )
    if PROOF_TOOL.search(tools):          # доказ у цьому ж ході — пропускаємо
        return 0

    claims = [
        s for s, q in lines
        if 15 < len(s) < 300
        and (VERDICT.search(q) or NUMBER.search(q) or RATIO.search(DATEISH.sub(" ", q)))
    ]
    if not claims:
        return 0
    return block(
        "СТОП: у відповіді є вердикт або цифри, але в цьому ході не запускався ні\n"
        "sto-claims-auditor, ні verdict.sh/measure.sh.\n\n"
        "Твердження, що потребують доказу (перші 5):\n",
        claims[:5],
        "\nЗробіть ОДНЕ з трьох:\n"
        "  1) Agent(subagent_type=\"sto-claims-auditor\") — якщо це підсумок роботи;\n"
        "  2) прогоніть verdict.sh / measure.sh і назвіть вивід;\n"
        "  3) якщо цифра взята з раніше названого виміру — скажіть ЗВІДКИ саме,\n"
        "     або прямо напишіть, що вона не перевірена цього ходу.\n",
    )


if __name__ == "__main__":
    sys.exit(main())
