#!/bin/sh
# postgres-mcp для Claude Code (.mcp.json → `wsl -e sh scripts/mcp/postgres-mcp.sh`), з прибиранням сиріт.
#
# ЧОМУ обгортка, хоча `--rm` стоїть: Claude Code, закриваючи сесію, вбиває wsl.exe, а клієнт `docker run`
# усередині WSL при цьому НЕ гине — переходить під PID 1, його stdin не закривається, і сервер працює
# далі. `--rm` прибирає контейнер лише після виходу, тож кожна закрита сесія лишала живий контейнер
# (2026-10-23 видалено 16; відтворено: kill wsl.exe → клієнт з ppid=1 і контейнер «Up»).
#
# Тому кожен запуск позначає контейнер PID свого клієнта (`sto.mcp.client`) і перед стартом прибирає
# ті, чий клієнт мертвий або осиротів (ppid=1). Живі сервери паралельних сесій не чіпає.
# DATABASE_URI приходить з Windows через WSLENV (див. .mcp.json, scripts/mcp/setup-readonly-db.ps1).
IMAGE='crystaldba/postgres-mcp@sha256:dbbd346860d29f1543e991f30f3284bf4ab5f096d049ecc3426528f20b1b6e6b'

for c in $(docker ps -aq --filter label=sto.mcp=postgres 2>/dev/null); do
  client=$(docker inspect -f '{{index .Config.Labels "sto.mcp.client"}}' "$c" 2>/dev/null)
  ppid=$(ps -o ppid= -p "$client" 2>/dev/null | tr -d ' ')
  comm=$(ps -o comm= -p "$client" 2>/dev/null)
  # Процес із цим PID — не `docker`: клієнт давно помер, а номер дістався іншому процесу (його не
  # чіпаємо, а контейнер — сирота).
  if [ -z "$ppid" ] || [ "$comm" != docker ] || [ "$ppid" = 1 ]; then
    [ "$comm" = docker ] && kill "$client" 2>/dev/null
    docker rm -f "$c" >/dev/null 2>&1
  fi
done

# exec зберігає PID оболонки, тож $$ — це PID самого клієнта `docker run`.
exec docker run -i --rm --label sto.mcp=postgres --label "sto.mcp.client=$$" --network host \
  -e DATABASE_URI "$IMAGE" --access-mode=restricted
