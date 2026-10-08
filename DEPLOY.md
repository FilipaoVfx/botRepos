# Manual de despliegue — VPS 24/7

Guía para dejar el bot corriendo permanentemente en un VPS (Ubuntu/Debian).
Tiempo estimado: ~15 min.

---

## 1. Requisitos previos

| Servicio | Qué necesitas |
|---|---|
| **VPS** | Ubuntu 22.04+ / Debian 12+, 1 vCPU y 512 MB–1 GB RAM sobran |
| **Node.js** | v18 o superior (recomendado v20 LTS) |
| **Supabase** | Proyecto con las tablas de datos (ver §6) |
| **Pinecone** | Índice de dimensión **1536**, métrica **cosine** |
| **OpenAI** | API key con acceso a `text-embedding-3-small` |
| **Telegram** | Token de bot creado con [@BotFather](https://t.me/BotFather) |

---

## 2. Instalar Node.js + PM2 en el VPS

```bash
# Node 20 LTS vía NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# PM2 (gestor de procesos)
sudo npm install -g pm2

node -v   # >= v18
```

---

## 3. Clonar y configurar

```bash
cd /opt          # o donde prefieras
git clone https://github.com/FilipaoVfx/botRepos.git
cd botRepos

npm install --omit=dev
cp .env.example .env
nano .env        # rellena TODAS las claves (ver §5)
```

---

## 4. Crear el bot en Telegram

1. Abre [@BotFather](https://t.me/BotFather) → `/newbot` → sigue los pasos.
2. Copia el token y pégalo en `TELEGRAM_BOT_TOKEN` dentro de `.env`.
3. (Grupos) Si lo usarás en grupos: BotFather → `/setprivacy` → **Disable**,
   para que el bot pueda leer los mensajes con menciones.

---

## 5. Variables de entorno (`.env`)

| Variable | Descripción | Dónde obtenerla |
|---|---|---|
| `SUPABASE_URL` | URL del proyecto | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave server-side (recomendada) | Supabase → Settings → API |
| `SUPABASE_ANON_KEY` | Fallback de solo lectura | Supabase → Settings → API |
| `PINECONE_API_KEY` | API key | app.pinecone.io → API Keys |
| `PINECONE_INDEX` | Nombre del índice (default `indexbook-knowledge`) | app.pinecone.io |
| `OPENAI_API_KEY` | API key | platform.openai.com/api-keys |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` (1536 dims) | — |
| `TELEGRAM_BOT_TOKEN` | Token del bot | @BotFather |

> El código carga `.env` automáticamente vía `dotenv`. No necesitas exportar nada a mano.

---

## 6. Preparar Pinecone y Supabase

### 6.1 Índice Pinecone

Crea un índice con:
- **Dimensions:** `1536` (para `text-embedding-3-small`)
- **Metric:** `cosine`
- **Name:** el mismo valor que pongas en `PINECONE_INDEX`

> Si cambias a `text-embedding-3-large`, la dimensión debe ser **3072** y hay
> que recrear el índice desde cero.

### 6.2 Tablas de Supabase

El bot **lee** de estas tablas (las alimenta el indexador principal):
- `bookmarks`
- `github_repo_readmes`

Y **gestiona** estas dos, específicas del RAG. Créalas si no existen (SQL Editor):

```sql
-- Estado de sincronización (evita re-embeddear contenido sin cambios)
create table if not exists rag_sync_state (
  source_type  text not null,
  source_id    text not null,
  chunk_index  int  not null,
  pinecone_id  text not null,
  content_hash text not null,
  synced_at    timestamptz default now(),
  primary key (source_type, source_id, chunk_index)
);

-- Log de consultas (métricas de uso)
create table if not exists rag_queries_log (
  id            bigint generated always as identity primary key,
  query         text,
  interface     text,          -- 'telegram' | 'cli' | 'api'
  results_count int,
  latency_ms    int,
  created_at    timestamptz default now()
);
```

---

## 7. Cargar el índice (ingesta inicial)

```bash
npm run ingest            # bookmarks + READMEs
# o por separado:
npm run ingest:bookmarks
npm run ingest:readmes
```

La ingesta es **idempotente**: usa `content_hash` en `rag_sync_state`, así que
re-ejecutarla solo procesa lo que cambió. Repítela periódicamente (ver §9).

---

## 8. Arrancar el bot con PM2 (24/7)

```bash
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save                       # persiste la lista de procesos
pm2 startup                    # genera el servicio systemd (ejecuta el comando que imprime)
```

Comandos útiles:

```bash
pm2 status
pm2 logs telegram-rag-bot      # ver logs en vivo
pm2 restart telegram-rag-bot
pm2 stop telegram-rag-bot
pm2 monit                      # dashboard
```

El bot se reinicia solo si crashea o si el VPS se reinicia (gracias a
`pm2 startup` + `pm2 save`).

---

## 9. Ingesta automática (timer de systemd)

La ingesta corre en el propio VPS cada 6 h (00:15, 06:15, 12:15 y 18:15, hora de
Bogotá) con `ops/botrepos-ingesta.timer`. El script `ops/ingest.sh` hace los
mismos pasos que tenía la GitHub Action:

1. `scripts/fetch-pending-readmes.js`: baja los READMEs pendientes.
2. `src/rag-ingest.js all`: embeddings nuevos → Pinecone (lo ya indexado se salta por `content_hash`).
3. `scripts/report-dense-missing-links.js`: reporte de bookmarks "densos" sin link.
4. `scripts/backfill-trust.js --stale-only`: refresca el Trust Score vencido.

Usa `flock` para que no corran dos a la vez, deja el resultado en
`/var/lib/botrepos/last-ingest.json` y sale con error si algún paso falla, lo
que dispara la alerta por Telegram (§14). `rag-ingest.js` sale con código 2 si
hubo errores parciales: antes un 429 de OpenAI dejaba READMEs sin indexar y la
corrida igual salía "success".

> La GitHub Action `RAG auto-ingest` quedó solo como disparo manual: GitHub
> desactiva los `schedule` de repos sin commits en 60 días. No la lances
> mientras corre la del VPS (no comparten el lock).

```bash
sudo systemctl start botrepos-ingesta.service     # ingesta ahora
journalctl -u botrepos-ingesta -n 50 --no-pager    # ver la última corrida
cat /var/lib/botrepos/last-ingest.json
```

---

## 10. Actualizar el bot

```bash
cd /opt/botRepos
git pull
npm install --omit=dev
pm2 restart telegram-rag-bot
```

---

## 11. Alternativa sin PM2: systemd

Si prefieres systemd directo, crea `/etc/systemd/system/telegram-rag-bot.service`:

```ini
[Unit]
Description=Telegram RAG Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/botRepos
ExecStart=/usr/bin/node src/telegram-bot.js start
Restart=always
RestartSec=5
User=www-data
EnvironmentFile=/opt/botRepos/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-rag-bot
sudo systemctl status telegram-rag-bot
journalctl -u telegram-rag-bot -f
```

> Nota: con `EnvironmentFile`, las líneas del `.env` no deben llevar comillas ni comentarios en la misma línea.

---

## 12. Troubleshooting

| Síntoma | Causa probable | Solución |
|---|---|---|
| `TELEGRAM_BOT_TOKEN is required` | `.env` no cargado / vacío | Verifica que arrancas desde la raíz del repo y que `.env` existe |
| `PINECONE_API_KEY is required` | Falta la clave | Rellena `.env` |
| El bot no responde en grupos | Privacy mode activo | @BotFather → `/setprivacy` → Disable |
| `0 resultados` siempre | Índice vacío o dimensión errónea | Corre `npm run ingest`; confirma índice de 1536 dims |
| `dimension mismatch` en Pinecone | Modelo ≠ dimensión del índice | Alinea `OPENAI_EMBEDDING_MODEL` con la dimensión del índice |
| Ingesta lenta / rate limit | Muchos embeddings | Normal; corre por lotes, reintenta |
| Enriquecimiento sin título/URL | Falta fila en Supabase | Verifica tablas `bookmarks` / `github_repo_readmes` |

---

## 13. Notas de seguridad

- **Nunca** subas `.env` (ya está en `.gitignore`). El repo es público.
- Usa `SUPABASE_SERVICE_ROLE_KEY` **solo** en el servidor, nunca en clientes.
- Rota las claves si alguna vez se filtran.
- Considera un usuario dedicado (no root) para correr el bot en el VPS.

---

## 14. Operación en el VPS (salud, alertas, logs)

Archivos en `ops/`:

| Archivo | Qué hace |
|---|---|
| `botrepos-ingesta.{service,timer}` + `ingest.sh` | Ingesta cada 6 h (§9) |
| `botrepos-salud.{service,timer}` + `scripts/healthcheck.js` | Chequeo de salud cada 5 min |
| `botrepos-alerta@.service` + `alerta.sh` | Alerta por Telegram cuando una unidad falla (`OnFailure=`) |
| `logrotate.botrepos` | Rotación semanal de `logs/*.log` (8 copias) |

**Instalación** (una vez, desde la raíz del repo). Las unidades asumen el repo en
`/root/botRepos`; si está en otra ruta, ajusta `WorkingDirectory`, `ExecStart` y
`EnvironmentFile` antes de copiarlas.

```bash
sudo cp ops/botrepos-*.service ops/botrepos-*.timer /etc/systemd/system/
sudo cp ops/logrotate.botrepos /etc/logrotate.d/botrepos
sudo systemctl daemon-reload
sudo systemctl enable --now botrepos-ingesta.timer botrepos-salud.timer
systemctl list-timers | grep botrepos
```

**Alertas.** `scripts/notify.js` manda el mensaje con el token del propio bot al
chat de `OPS_CHAT_ID` (tu user_id de Telegram; antes escríbele `/start` al bot).
Sin `OPS_CHAT_ID` las alertas solo quedan en el journal.
Prueba: `node scripts/notify.js "prueba"`.

**Chequeo de salud.** `scripts/healthcheck.js` revisa:
- PM2 (`telegram-rag-bot` online y si reinició)
- `/healthz` del dashboard
- Telegram `getMe`
- Supabase y Pinecone
- Antigüedad de la última ingesta (`INGEST_MAX_AGE_H`, 13 h)
- RAM disponible (`MIN_AVAILABLE_MB`, 300)
- Si el indexer dejó de traer bookmarks (`FRESHNESS_DAYS`, 14)

Solo avisa en las **transiciones** (falla → "🔴 Problema", vuelve → "🟢 Recuperado");
el estado vive en `/var/lib/botrepos/health.json`. `--dry-run` imprime sin avisar.
Un `pm2 restart` manual también cuenta como reinicio y se avisa una vez.

**Dashboard.** Escucha en `:8787` con token, pero el firewall solo abre 22/80/443.
Para verlo, abre un túnel: `ssh -L 8787:localhost:8787 <usuario>@<servidor>` y
visita `http://localhost:8787/?token=<DASHBOARD_TOKEN>`.

**Memoria.** `ecosystem.config.cjs` limita el heap a 192 MB y PM2 reinicia el
proceso si pasa de 300 MB. Tras cambiar `node_args` hay que recrear el proceso:
`pm2 delete telegram-rag-bot && pm2 start ecosystem.config.cjs && pm2 save`.
