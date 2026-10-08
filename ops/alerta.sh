#!/usr/bin/env bash
# Alerta de fallo de una unidad systemd (la invoca botrepos-alerta@.service vía
# OnFailure=). Manda a Telegram el nombre de la unidad y sus últimas líneas.
#   ops/alerta.sh <unidad>
set -u
unidad="${1:?uso: alerta.sh <unidad>}"
cd "$(dirname "$0")/.."
cola="$(journalctl -u "$unidad" -n 8 --no-pager -o cat 2>/dev/null | cut -c1-200)"
exec /usr/bin/node scripts/notify.js "❌ Falló ${unidad}
${cola}
→ journalctl -u ${unidad} -n 50"
