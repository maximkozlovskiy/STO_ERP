#!/usr/bin/env bash
# Встановлення Docker Engine у WSL2 (Ubuntu/Debian)
# Запуск: bash /mnt/e/Git/STO\ ERP/scripts/wsl2-docker-install.sh

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC} $*"; }
warning() { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERR ]${NC} $*"; exit 1; }

# ── 1. Перевірка WSL2 ─────────────────────────────────────────────────────────
if ! grep -qi microsoft /proc/version 2>/dev/null; then
  error "Скрипт призначений для WSL2. Запусти з Ubuntu в WSL2."
fi

DISTRO=$(lsb_release -si 2>/dev/null || echo "Unknown")
info "Дистрибутив: $DISTRO $(lsb_release -sr 2>/dev/null)"

# ── 2. Видалення старих версій ────────────────────────────────────────────────
info "Видалення старих пакетів docker..."
sudo apt-get remove -y docker docker-engine docker.io containerd runc 2>/dev/null || true

# ── 3. Залежності ─────────────────────────────────────────────────────────────
info "Встановлення залежностей..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
  ca-certificates curl gnupg lsb-release

# ── 4. Docker GPG ключ ────────────────────────────────────────────────────────
info "Додавання Docker GPG ключа..."
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# ── 5. Docker репозиторій ─────────────────────────────────────────────────────
info "Додавання Docker репозиторію..."
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# ── 6. Встановлення Docker Engine ─────────────────────────────────────────────
info "Встановлення Docker Engine..."
sudo apt-get update -qq
sudo apt-get install -y \
  docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

# ── 7. Група docker ───────────────────────────────────────────────────────────
info "Додавання $USER до групи docker..."
sudo usermod -aG docker "$USER"

# ── 8. Запуск dockerd ─────────────────────────────────────────────────────────
info "Запуск Docker daemon..."
sudo service docker start || sudo dockerd &>/dev/null &
sleep 2

# ── 9. Автозапуск при старті WSL2 ─────────────────────────────────────────────
BASHRC="$HOME/.bashrc"
MARKER="# sto-erp docker autostart"

if ! grep -q "$MARKER" "$BASHRC" 2>/dev/null; then
  info "Додавання автозапуску docker до ~/.bashrc..."
  cat >> "$BASHRC" << 'BASHRC_BLOCK'

# sto-erp docker autostart
if service docker status 2>&1 | grep -q "not running"; then
  sudo service docker start > /dev/null 2>&1
fi
BASHRC_BLOCK
fi

# ── 10. sudoers — docker без пароля ───────────────────────────────────────────
SUDOERS_FILE="/etc/sudoers.d/docker-service"
if [ ! -f "$SUDOERS_FILE" ]; then
  info "Налаштування sudo для service docker (без пароля)..."
  echo "$USER ALL=(ALL) NOPASSWD: /usr/sbin/service docker *" \
    | sudo tee "$SUDOERS_FILE" > /dev/null
  sudo chmod 440 "$SUDOERS_FILE"
fi

# ── 11. Aliases для STO ERP ───────────────────────────────────────────────────
STO_PATH="/mnt/e/Git/STO ERP"
MARKER2="# sto-erp aliases"

if ! grep -q "$MARKER2" "$BASHRC" 2>/dev/null; then
  info "Додавання STO ERP aliases до ~/.bashrc..."
  cat >> "$BASHRC" << BASHRC_BLOCK2

$MARKER2
STO_ERP_PATH="$STO_PATH"
alias sto-up='docker compose -f "\$STO_ERP_PATH/docker-compose.dev.yml" up -d'
alias sto-down='docker compose -f "\$STO_ERP_PATH/docker-compose.dev.yml" down'
alias sto-logs='docker compose -f "\$STO_ERP_PATH/docker-compose.dev.yml" logs -f'
alias sto-ps='docker compose -f "\$STO_ERP_PATH/docker-compose.dev.yml" ps'
alias sto-restart='docker compose -f "\$STO_ERP_PATH/docker-compose.dev.yml" restart'
BASHRC_BLOCK2
fi

# ── 12. Перевірка ─────────────────────────────────────────────────────────────
info "Перевірка встановлення..."
if sudo docker run --rm hello-world &>/dev/null; then
  info "Docker працює!"
else
  warning "docker run hello-world не вдався — можливо треба newgrp docker або перезапуск WSL2"
fi

DOCKER_VER=$(docker --version 2>/dev/null || echo "невідомо")
COMPOSE_VER=$(docker compose version 2>/dev/null || echo "невідомо")

echo ""
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo -e "${GREEN} Docker Engine встановлено успішно!${NC}"
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo "  Docker:  $DOCKER_VER"
echo "  Compose: $COMPOSE_VER"
echo ""
echo "  Aliases доступні після: source ~/.bashrc"
echo ""
echo "  sto-up       → запустити БД + Redis + MinIO"
echo "  sto-down     → зупинити"
echo "  sto-logs     → логи"
echo "  sto-ps       → статус контейнерів"
echo ""
echo -e "${YELLOW}ВАЖЛИВО: виконай 'newgrp docker' або перезапусти WSL2${NC}"
echo -e "${YELLOW}         щоб використовувати docker без sudo${NC}"
