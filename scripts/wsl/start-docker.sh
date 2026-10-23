#!/bin/bash
# Запуск dockerd у WSL — рівно ОДИН на дистрибутив, хоч би скільки разів і звідки скрипт викликали:
# `[boot] command` у /etc/wsl.conf, задача Windows «STO WSL Docker» (scripts/wsl/setup-docker-autostart.ps1),
# вручну. Встановлюється в /usr/local/bin/start-docker.sh тим самим setup-скриптом.
#
# ЧОМУ так: до 2026-10-23 dockerd стартували три місця ([boot], ~/.bashrc `sudo dockerd &`, ручний
# `service docker start`), і вони змагались — у /var/log/dockerd.log «address already in use» та
# «process with PID 31 is still running». А дистрибутив без systemd гасне, щойно закривається остання
# сесія wsl.exe, і dockerd гине з ним. Тому скрипт не виходить, доки живий Docker: або чекає свій dockerd, або спить —
# і відкритий wsl.exe задачі Windows тримає дистрибутив (і Docker) живим.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# /run — tmpfs: лок зникає разом із сеансом WSL. Лок тримає ЦЕЙ скрипт, доки живий dockerd (wait
# нижче), а не сам демон: дескриптор без close-on-exec успадкували б containerd і containerd-shim, що
# переживають падіння dockerd, — і перезапуск задачі вічно спав би на чужому локі без Docker.
exec 9>/run/start-docker.lock
if ! flock -n 9; then
  exec sleep infinity # dockerd уже запустив інший виклик цього скрипта
fi

# Демон, запущений повз скрипт (`service docker start`), — не дублювати. Саме процес, а не `docker info`:
# демон, що ще стартує, на запит не відповідає, і другий dockerd упав би на тому самому сокеті.
if pgrep -x dockerd >/dev/null; then
  exec sleep infinity
fi

# `9>&-` — демон і його нащадки лока не бачать; скрипт виходить разом із dockerd (код виходу демона),
# лок звільняється, і задача Windows може запустити його знову.
/usr/bin/dockerd >>/var/log/dockerd.log 2>&1 9>&- &
wait $!
