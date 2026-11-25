#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Clean Kitchen — установка/обновление на VPS (Ubuntu/Debian, Contabo и др.) ОДНОЙ командой.
#
#   curl -fsSL https://raw.githubusercontent.com/azimjon-95/kitchen-backend/main/deploy/install.sh | sudo bash -s -- --domain kitchen.example.com
#
# Без домена: сайт получит адрес вида 1-2-3-4.sslip.io с настоящим HTTPS.
# Повторный запуск = обновление (git pull + пересборка); пароли и данные сохраняются.
# Опции: --domain D  --admin-email E  --git-token T (для приватных репозиториев)  --int8 (быстрее, чуть менее точно)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT=/opt/clean-kitchen
BACKEND_REPO=https://github.com/azimjon-95/kitchen-backend.git
CLIENT_REPO=https://github.com/azimjon-95/clean-kitchen.git
DOMAIN="" ADMIN_EMAIL="" GIT_TOKEN="${GIT_TOKEN:-}" INT8=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --git-token) GIT_TOKEN="$2"; shift 2 ;;
    --int8) INT8=1; shift ;;
    *) echo "Неизвестный параметр: $1"; exit 1 ;;
  esac
done

say() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Запустите через sudo"; exit 1; }

say "Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq curl git openssl ca-certificates cron >/dev/null

if ! command -v docker >/dev/null; then say "Установка Docker"; curl -fsSL https://get.docker.com | sh >/dev/null; fi
systemctl enable --now docker >/dev/null 2>&1 || true

# Swap: сборка torch и модель речи требуют памяти; на 4–8 ГБ VPS swap спасает от падений
if [ "$(swapon --show --noheadings | wc -l)" -eq 0 ] && [ "$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)" -lt 12000 ]; then
  say "Создаю swap 4 ГБ"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -qw vm.swappiness=10; echo 'vm.swappiness=10' > /etc/sysctl.d/99-clean-kitchen.conf
fi

say "Код"
mkdir -p "$ROOT" "$ROOT/backups"
auth_url() { if [ -n "$GIT_TOKEN" ]; then echo "$1" | sed "s#https://#https://x-access-token:${GIT_TOKEN}@#"; else echo "$1"; fi; }
sync_repo() { # $1 url  $2 dir
  if [ -d "$2/.git" ]; then git -C "$2" fetch -q "$(auth_url "$1")" main && git -C "$2" reset -q --hard FETCH_HEAD
  else git clone -q --depth 1 "$(auth_url "$1")" "$2"; git -C "$2" remote set-url origin "$1"; fi   # токен не сохраняется на диске
}
sync_repo "$BACKEND_REPO" "$ROOT/backend"
sync_repo "$CLIENT_REPO" "$ROOT/client"
cd "$ROOT/backend"

# Порты 80/443 заняты другим сайтом (nginx и т.п.)? Тогда встаём за него на 127.0.0.1:8088
PROXY_MODE=direct
if ss -ltnp 2>/dev/null | grep -E ':(80|443)\s' | grep -vq docker-proxy; then PROXY_MODE=external; fi

if [ -z "$DOMAIN" ] && [ -f .env ]; then DOMAIN=$(grep -E '^SITE_DOMAIN=' .env | cut -d= -f2- || true); fi
if [ -z "$DOMAIN" ]; then
  IP=$(curl -4 -fsS --max-time 8 https://api.ipify.org || hostname -I | awk '{print $1}')
  DOMAIN="${IP//./-}.sslip.io"
fi

rand() { openssl rand -hex "$1"; }
if [ ! -f .env ]; then
  say "Создаю секреты (.env)"
  SA_EMAIL="${ADMIN_EMAIL:-admin@clean-kitchen.local}"
  SA_PASS="Ck$(rand 9)9"
  umask 077
  cat > .env <<ENV
# Сгенерировано install.sh $(date -u +%F). Не публикуйте этот файл.
SITE_DOMAIN=$DOMAIN
NODE_ENV=production
JWT_ACCESS_SECRET=$(rand 48)
JWT_REFRESH_SECRET=$(rand 48)
JWT_SECRET=$(rand 48)
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL=30d
APP_ORIGIN=https://$DOMAIN
CLIENT_ORIGIN=https://$DOMAIN
SUPER_ADMIN_EMAIL=$SA_EMAIL
SUPER_ADMIN_PASSWORD=$SA_PASS
MONGO_USER=ck
MONGO_PASSWORD=$(rand 24)
REDIS_PASSWORD=$(rand 24)
STT_SERVICE_TOKEN=$(rand 32)
GIGAAM_MODEL=v3_e2e_rnnt
GIGAAM_INT8=$INT8
# Резервное распознавание (необязательно): ключ Groq
# STT_API_KEY=
ENV
  printf 'Сайт: https://%s\nSuper Admin: %s\nПароль: %s\n(смените пароль после входа)\n' "$DOMAIN" "$SA_EMAIL" "$SA_PASS" > "$ROOT/CREDENTIALS.txt"
  chmod 600 "$ROOT/CREDENTIALS.txt"
else
  sed -i "s#^SITE_DOMAIN=.*#SITE_DOMAIN=$DOMAIN#; s#^APP_ORIGIN=.*#APP_ORIGIN=https://$DOMAIN#; s#^CLIENT_ORIGIN=.*#CLIENT_ORIGIN=https://$DOMAIN#" .env
  [ "$INT8" = 1 ] && sed -i 's#^GIGAAM_INT8=.*#GIGAAM_INT8=1#' .env
fi
chmod 600 .env

# Параметры запуска compose (не секретные)
{
  if [ "$PROXY_MODE" = external ]; then
    echo "SITE_ADDRESS=:80"; echo "HTTP_BIND=127.0.0.1:8088"; echo "HTTPS_BIND=127.0.0.1:8443"
  else
    echo "SITE_ADDRESS=$DOMAIN"; echo "HTTP_BIND=80"; echo "HTTPS_BIND=443"
  fi
  echo "CLIENT_DIR=$ROOT/client"; echo "BACKUP_DIR=$ROOT/backups"
  CPUS=$(nproc); echo "STT_CPUS=$(( CPUS > 2 ? 2 : CPUS ))"; echo "STT_THREADS=$(( CPUS > 2 ? 2 : CPUS ))"
} > deploy/runtime.env
cat .env deploy/runtime.env > deploy/.compose.env; chmod 600 deploy/.compose.env

DC="docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.compose.env"

if command -v ufw >/dev/null; then
  say "Брандмауэр"
  SSH_PORT=$(ss -ltnp | awk '/sshd/{split($4,a,":"); print a[length(a)]; exit}'); SSH_PORT=${SSH_PORT:-22}
  ufw allow "$SSH_PORT"/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

say "Сборка (первый раз 10–25 минут: скачиваются torch и модель речи)"
$DC build --pull
say "Запуск"
$DC up -d --remove-orphans

say "Проверка"
for i in $(seq 1 60); do
  st=$(docker inspect -f '{{.State.Health.Status}}' "$($DC ps -q api)" 2>/dev/null || echo starting)
  [ "$st" = healthy ] && break; sleep 5
done
echo "API: $st"
for i in $(seq 1 40); do
  sst=$(docker inspect -f '{{.State.Health.Status}}' "$($DC ps -q stt)" 2>/dev/null || echo starting)
  [ "$sst" = healthy ] && break; sleep 5
done
echo "Распознавание речи (GigaAM): $sst"

# Ежедневная резервная копия базы в 03:30, храним 14 дней
cat > /etc/cron.d/clean-kitchen-backup <<CRON
30 3 * * * root cd $ROOT/backend && $DC exec -T mongo sh -c 'mongodump -u "\$MONGO_INITDB_ROOT_USERNAME" -p "\$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --gzip --archive=/backups/ck-\$(date +\%F).gz' >/dev/null 2>&1; find $ROOT/backups -name 'ck-*.gz' -mtime +14 -delete
CRON
docker image prune -f >/dev/null 2>&1 || true

echo
echo "════════════════════════════════════════════════════"
echo " Готово: https://$DOMAIN"
[ -f "$ROOT/CREDENTIALS.txt" ] && echo " Данные входа: sudo cat $ROOT/CREDENTIALS.txt"
if [ "$PROXY_MODE" = external ]; then
  echo
  echo " Порты 80/443 заняты другим сервером. Добавьте в его nginx (с HTTPS для $DOMAIN):"
  echo "   location / { proxy_pass http://127.0.0.1:8088; proxy_set_header Host \$host;"
  echo "     proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto https;"
  echo "     client_max_body_size 25m; proxy_read_timeout 60s; }"
fi
echo " Логи:     cd $ROOT/backend && $DC logs -f --tail 100"
echo " Обновить: повторите ту же команду установки"
echo "════════════════════════════════════════════════════"
