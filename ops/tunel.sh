#!/usr/bin/env bash
# Publica el dashboard (:PORT) con un túnel rápido de Cloudflare (sin dominio).
# La URL *.trycloudflare.com cambia en cada arranque: al detectarla la guarda en
# $STATE_DIR/tunel-url.txt y la manda por Telegram al chat de OPS_CHAT_ID, con
# el token, lista para abrir.
#   ops/tunel.sh   (lo corre botrepos-tunel.service)
set -uo pipefail
cd "$(dirname "$0")/.."

STATE_DIR="${STATE_DIRECTORY:-/var/lib/botrepos}"
PORT="${PORT:-8787}"
mkdir -p "$STATE_DIR"
rm -f "$STATE_DIR/tunel-url.txt"

avisado=""
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${PORT}" 2>&1 | while IFS= read -r linea; do
  echo "$linea"
  if [ -z "$avisado" ] && [[ "$linea" =~ (https://[a-z0-9-]+\.trycloudflare\.com) ]]; then
    url="${BASH_REMATCH[1]}"
    echo "$url" > "$STATE_DIR/tunel-url.txt"
    /usr/bin/node scripts/notify.js "📊 Panel de monitoreo — URL nueva del túnel:
${url}/?token=${DASHBOARD_TOKEN:-}&days=7" || true
    avisado=1
  fi
done
