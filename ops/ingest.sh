#!/usr/bin/env bash
# Ingesta RAG completa (la corre botrepos-ingesta.timer cada 6 h). Mismos pasos
# que tenía la GitHub Action, que ahora queda solo para disparo manual:
#   1) baja READMEs pendientes   2) embeddings nuevos → Pinecone
#   3) reporte de densos sin link   4) refresco del Trust Score (lo vencido)
# Deja el resultado en $STATE_DIR/last-ingest.json (lo lee el healthcheck) y
# sale != 0 si algún paso falló, para que systemd dispare la alerta.
#   ops/ingest.sh
set -uo pipefail
cd "$(dirname "$0")/.."

STATE_DIR="${STATE_DIRECTORY:-/var/lib/botrepos}"
mkdir -p "$STATE_DIR"

# Nunca dos ingestas a la vez (timer + disparo manual).
exec 9>"$STATE_DIR/ingest.lock"
if ! flock -n 9; then
  echo "Otra ingesta en curso; salgo sin hacer nada."
  exit 0
fi

inicio="$(date -Is)"
fallos=()
paso() {
  local nombre="$1"; shift
  echo "── ${nombre}: $*"
  "$@" || fallos+=("${nombre}")
}

export INGEST_SUMMARY_FILE="$STATE_DIR/ingest-summary.json"
rm -f "$INGEST_SUMMARY_FILE"

paso readmes node scripts/fetch-pending-readmes.js --limit=100
paso ingesta node src/rag-ingest.js all
paso densos  node scripts/report-dense-missing-links.js --user=local-user --limit=100
paso trust   node scripts/backfill-trust.js --stale-only --source=all --limit="${TRUST_REFRESH_LIMIT:-40}"

estado="ok"
[ "${#fallos[@]}" -gt 0 ] && estado="error"
resumen="$(cat "$INGEST_SUMMARY_FILE" 2>/dev/null || echo null)"
fallos_json=""
[ "${#fallos[@]}" -gt 0 ] && fallos_json="$(printf '"%s",' "${fallos[@]}")"
printf '{"status":"%s","started_at":"%s","finished_at":"%s","failed_steps":[%s],"summary":%s}\n' \
  "$estado" "$inicio" "$(date -Is)" "${fallos_json%,}" "$resumen" > "$STATE_DIR/last-ingest.json"

if [ "$estado" != "ok" ]; then
  echo "Pasos fallidos: ${fallos[*]}"
  exit 1
fi
echo "Ingesta OK."
