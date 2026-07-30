# Manual de réplica del VPS `<HOSTNAME>`

Guía para levantar un VPS nuevo idéntico a este en configuración, servicios y aplicaciones desplegadas.

- **Fecha de la auditoría:** 2026-07-30
- **Método:** inspección directa de `docker ps -a`, `docker images`, `docker volume ls`, `systemctl`, `pm2 list`, `crontab -l`, `ss -tlnp`, `/etc/nginx`, y `git remote -v` de cada repo.

> Documento saneado para publicación: direcciones IP, hostname y detalles de exposición del host auditado están redactados. Sustituye los marcadores `<VPS_IP>`, `<HOSTNAME>` y las contraseñas de ejemplo por los valores de tu entorno.

---

## 1. Ficha del host de referencia

| Ítem | Valor |
|---|---|
| Distro | Ubuntu 24.04.4 LTS (noble) |
| Kernel | 6.8.0-124-generic x86_64 |
| CPU | 1 vCPU |
| RAM | 1.9 GiB + 4 GiB swap (`/swapfile`) |
| Disco | 48 GB (`/dev/vda1`) |
| Proveedor | DigitalOcean |

**Recomendación de tamaño para la réplica:** con 1 vCPU / 2 GB sólo cabe el stack Guardian + n8n, y el disco se satura rápido. Si vas a levantar el stack completo (incluido OpenCut-AI, que descarga modelos de IA), usa mínimo **2 vCPU / 4 GB RAM / 80 GB disco**.

### Runtimes instalados en el host

| Herramienta | Versión |
|---|---|
| Docker Engine | 29.5.3 (+ plugin `docker compose` v2) |
| containerd | servicio propio, habilitado |
| Node.js | v22.22.3 |
| npm | 10.9.8 |
| Bun | 1.3.14 |
| Python | 3.12.3 (+ pip 24.0 del sistema) |
| nginx | paquete Ubuntu, habilitado |
| git | 2.43.0 |
| cloudflared | 2026.7.3 (`/usr/local/bin/cloudflared`) |
| ttyd | 1.7.4 (`/usr/bin/ttyd`) |
| PM2 | 7.0.3 (global, `/usr/lib/node_modules/pm2`) |

Paquetes npm globales: `@anthropic-ai/claude-code@2.1.220`, `pm2@7.0.3`, `corepack@0.34.6`.

Snaps: `chromium`, `cups`, `core22`, `core24`, `snapd` (chromium se usa para scraping/OSINT; los demás vienen de la imagen base).

> No hay Go instalado en el host: el backend de Guardian compila dentro del contenedor (`golang:1.22-alpine` en multi-stage). El CLI de Guardian sí requiere Go 1.24.5 si quieres recompilarlo (ver §6.1).

---

## 2. Inventario de repositorios

Todos los repos viven bajo `/root`. Esta es la referencia canónica para clonar.

| Directorio | Remote | Rama | Último commit auditado |
|---|---|---|---|
| `/root/hackaton-sync` | `https://github.com/FilipaoVfx/hackatonv2Colsubsidio.git` | `main` | `78883f5 docs: modernización del repositorio` |
| `/root/guardian-ai` | **sin remote** (git local, rama `master`) | `master` | `7a7154a docs(backend): README de módulo` |
| `/root/colsubsidio-seguros-api` | `https://github.com/Tovar-D3v/colsubsidio-seguros-api.git` | `main` | `460025a actualizacion para excepciones y corsheaders` |
| `/root/botRepos` | `https://github.com/FilipaoVfx/botRepos.git` | `main` | `3826a3f feat(repos): show real GitHub stars` |
| `/root/landingHackaton30x` | `https://github.com/FilipaoVfx/landingHackaton30x.git` | `main` | `8b70657 chore: retrigger deploy` |
| `/root/landing-deploy` | `https://github.com/FilipaoVfx/landingHackaton30x.git` (mismo remote) | `main` | `048e02c chore: regraba el GIF de la CLI` |
| `/root/guardian-ia-landing` | **sin git** (copia de trabajo del landing) | — | — |
| `/root/operacionColombia` | `https://github.com/FilipaoVfx/operacionColombia` | `feat/ola1-connector-engine` | `280136a feat(observability): M14` |
| `/root/Agent-Reach` | `https://github.com/Panniantong/Agent-Reach.git` | `main` | `e825f67 Merge PR #469` |
| `/root/indexerdevops` | `https://gitlab.com/indexerdevops/indexerdevops.git` | `main` | `2e73a58 docs(observability)` |
| `/root/OpenCut-AI` | `https://github.com/Ekaanth/OpenCut-AI` | `main` | `fa2764d Merge origin/main` |
| `/root/monitoring` | **sin git** (stack local, derivado de `indexerdevops/observability`) | — | — |

### 2.1 Relación entre repos Guardian (importante)

`/root/guardian-ai` es **el directorio desplegado** y no tiene remote: es un git local. Su código fuente aguas arriba es el subdirectorio `guardian-ai/` del repo `hackatonv2Colsubsidio` (clonado en `/root/hackaton-sync`).

Diferencias verificadas entre `/root/hackaton-sync/guardian-ai` y `/root/guardian-ai`:

- `/root/guardian-ai` tiene además: `.env` (secretos reales), `backend/guardianai/`, `cli/bin/`, `cli/dist/`, `frontend/dist/`, `frontend/node_modules/`, `docker-compose.yml.bak-1912`.
- `docker-compose.yml`, `README.md` y `frontend/index.html` **difieren** entre ambos.
- `hackaton-sync` conserva un frontend viejo (`app.js`, `chat.html`, `guardian.css`) que el desplegado ya no usa (el desplegado es React + Vite + HeroUI).

**Para la réplica:** clona `hackatonv2Colsubsidio`, copia `guardian-ai/` a `/root/guardian-ai`, y aplica el `docker-compose.yml` que se transcribe en §6.1 (es el del host, no el del repo). Alternativa más fiel y recomendada: rsync directo del directorio desplegado (ver §11).

### 2.2 Relación entre repos del landing

Tres directorios comparten el mismo código de landing:

- `/root/landingHackaton30x` — clon canónico del repo.
- `/root/landing-deploy` — segundo clon del mismo remote; es el `cwd` de dos procesos PM2 de túneles (herencia histórica, el código no se usa desde ahí).
- `/root/guardian-ia-landing` — copia **sin git**; es la que se compila. Su `dist/` se publica en `/var/www/guardian-ia-landing` (nginx :8090) y además corre `vite preview` en :4173 vía PM2.

---

## 3. Contenedores Docker — estado completo

### 3.1 Contenedores existentes (8, todos en ejecución; **no hay contenedores detenidos**)

| Nombre | Imagen | Estado | Puertos host→cont. | Red / alias | Origen |
|---|---|---|---|---|---|
| `guardian-ai-nginx-1` | `nginx:1.24-alpine` | Up | `8099→80` | `guardian-ai_default` | compose `/root/guardian-ai` |
| `guardian-ai-backend-1` | `guardian-ai-backend` (build local) | Up | interno `3000` | `guardian-ai_default` | compose `/root/guardian-ai` |
| `guardian-ai-demo-protege-1` | `guardian-ai-demo-protege` (build local) | Up | `9002→9000` | `guardian-ai_default` | compose `/root/guardian-ai` |
| `guardian-ai-studio-mock-1` | `guardian-ai-studio-mock` (build local) | Up | interno `9000` | `guardian-ai_default` | compose `/root/guardian-ai` |
| `n8n` | `docker.n8n.io/n8nio/n8n:latest` | Up | `5678→5678` | `bridge` | `docker run` manual |
| `protege-api` | `colsubsidio-protege-api` (build local) | Up (healthy) | `9000→9000` | `guardian-ai_default`, **alias `mock-protege`** | `docker run` manual |
| `protege-db` | `postgres:16-alpine` | Up | `5432→5432` | `bridge` + `guardian-ai_default` | `docker run` manual |
| `guardian-fallback-test` | `guardian-ai-backend` (tag `f552c978caa3`) | Up | ninguno | `guardian-ai_default` | contenedor de prueba ad-hoc |

Notas críticas:

- **`protege-api` y `protege-db` NO están en ningún compose.** Se crearon con `docker run` y se conectaron a mano a la red `guardian-ai_default`. El alias de red `mock-protege` es lo que hace que el backend de Guardian hable con la API real sin cambiar código. Reproducir esto es el paso más fácil de olvidar (§6.2).
- **`guardian-fallback-test` es descartable**: contenedor de prueba manual, sin puertos, `restart: no`. No lo repliques.
- **`protege-db` usa un volumen anónimo** (`043836809ce3...`) para `/var/lib/postgresql/data`. Un volumen anónimo se pierde si alguien recrea el contenedor sin cuidado. En la réplica se crea con nombre (`protege-db-data`). **Si necesitas los datos actuales, haz dump antes (§11).**
- `protege-db` tiene `restart: no`: **no sobrevive a un reboot**. En la réplica se corrige a `unless-stopped`.

### 3.2 Stacks definidos pero apagados

Estas imágenes están descargadas y sus stacks configurados, pero **no tienen contenedores**:

| Stack | Ubicación | Imágenes presentes | Estado |
|---|---|---|---|
| Monitoring (Prometheus + Grafana + exporters) | `/root/monitoring/docker-compose.yml` | `prom/prometheus`, `grafana/grafana`, `prom/node-exporter`, `prom/blackbox-exporter:v0.25.0` | apagado; volúmenes `monitoring_prometheus-data`, `monitoring_grafana-data` conservan datos |
| OpenCut-AI | `/root/OpenCut-AI/docker-compose.yml` | `postgres:17`, `redis:7-alpine`, `hiett/serverless-redis-http` | apagado; volumen `opencut-ai_postgres_data` conserva datos |
| Mock Protege (perfil `mock`) | `/root/guardian-ai` (perfil `mock`) | `guardian-ai-mock-protege` | apagado a propósito: la API real ocupa el 9000 |
| SonarQube | `/root/indexerdevops/sonarqube/docker-compose.yml` | ninguna descargada | nunca levantado en este host |
| Observability (indexer) | `/root/indexerdevops/observability/docker-compose.yml` | comparte imágenes con `monitoring` | nunca levantado; `/root/monitoring` es su versión simplificada |

Imágenes auxiliares presentes: `golang:1.22-alpine` y `alpine:3.20` (etapas de build del backend Guardian).

### 3.3 Volúmenes Docker

| Volumen | Usado por | Contenido |
|---|---|---|
| `guardian-ai_guardian-config` | `guardian-ai-backend-1` → `/var/lib/guardian` | config del Agent Studio (sobrevive rebuilds) |
| `n8n_data` | `n8n` → `/home/node/.n8n` | workflows, credenciales, SQLite de n8n |
| `043836809ce3…` (anónimo) | `protege-db` → `/var/lib/postgresql/data` | base de datos Protege |
| `monitoring_prometheus-data` | stack monitoring (apagado) | series temporales |
| `monitoring_grafana-data` | stack monitoring (apagado) | dashboards, usuarios |
| `opencut-ai_postgres_data` | stack OpenCut (apagado) | DB de OpenCut |
| `guardian-gocache`, `guardian-gomod`, `gomodcache` | builds Go | cachés reconstruibles — no migrar |
| `9896b1ea…`, `b54dfb82…` | huérfanos | reconstruibles — no migrar |

### 3.4 Redes Docker

- `bridge` (default), `host`, `none` — estándar.
- `guardian-ai_default` — creada por el compose de Guardian. **`protege-api` y `protege-db` se enganchan a esta red manualmente.**

---

## 4. Servicios systemd propios

| Unidad | Estado actual | Función |
|---|---|---|
| `cloudflared-guardian.service` | activo, habilitado | túnel quick de Cloudflare → `http://localhost:8099` (demo Guardian) |
| `cloudflared-tunnel.service` | activo, habilitado | túnel quick → `http://localhost:8787` (dashboard botRepos) |
| `osint-panel.service` | **inactivo**, habilitado | panel OSINT de operacionColombia (`node apps/api/server.js`, `PORT=8081`) |
| `ttyd.service` | activo, habilitado | ttyd en `127.0.0.1:7681` con `-O login` |
| `pm2-root.service` | habilitado (resurrect al boot) | levanta los procesos PM2 |
| `nginx.service` | activo, habilitado | sirve el landing en :8090 |
| `docker.service`, `containerd.service` | activos, habilitados | runtime |

Los túneles son **quick tunnels**: la URL `*.trycloudflare.com` cambia en cada reinicio. No hay túnel con nombre ni credenciales persistentes. Si necesitas URLs estables en la réplica, migra a un túnel nombrado (`cloudflared tunnel create`).

## 5. Procesos PM2 (5)

| Nombre | Comando | cwd |
|---|---|---|
| `telegram-rag-bot` | `node src/telegram-bot.js start` | `/root/botRepos` |
| `guardian-preview` | `bash -c 'npx vite preview --port 4173 --host 127.0.0.1'` | `/root/guardian-ia-landing` |
| `secura-ttyd` | `bash cli/scripts/web-terminal.sh` (ttyd :7682 → CLI Secura read-only) | `/root/guardian-ai/cli` |
| `secura-api-tunnel` | `cloudflared tunnel --url http://localhost:8099 --no-autoupdate --logfile /root/.secura/secura-api-tunnel.log` | `/root/landing-deploy` |
| `secura-ttyd-tunnel` | `cloudflared tunnel --url http://localhost:7682 --no-autoupdate --logfile /root/.secura/secura-ttyd-tunnel.log` | `/root/landing-deploy` |

> Hay redundancia real en el host: `cloudflared-guardian.service` (systemd) y `secura-api-tunnel` (PM2) apuntan ambos a `:8099`. En la réplica puedes quedarte con uno solo.

## 6. Cron

```cron
0 4 * * * /root/botRepos/ingest.sh >> /root/botRepos/logs/ingest.log 2>&1
```

Además de los cron del sistema (`e2scrub_all`, `sysstat`), que vienen por defecto.

## 7. Mapa de puertos

Binding recomendado para la réplica. Todo lo que sólo consumen procesos locales o la red Docker va atado a `127.0.0.1`; el resto queda tras la allowlist de `ufw` del Paso 0.

| Puerto | Binding | Servicio |
|---|---|---|
| 22 | público (allowlist) | SSH |
| 4173 | `127.0.0.1` | vite preview del landing (PM2 `guardian-preview`) |
| 5432 | `127.0.0.1` | PostgreSQL `protege-db` — **nunca público**, la API llega por red Docker |
| 5678 | público (allowlist) | n8n |
| 7681 | `127.0.0.1` | ttyd del sistema |
| 7682 | `127.0.0.1` | ttyd Secura CLI (se publica sólo vía túnel Cloudflare) |
| 8090 | público (allowlist) | nginx → landing estático |
| 8099 | público (allowlist) | nginx del stack Guardian (SPA + `/api/` + `/ws`) |
| 8787 | público (allowlist) | dashboard botRepos (proceso node del bot) |
| 9000 | red Docker (público opcional) | `protege-api` (FastAPI, Colsubsidio Protege) |
| 9002 | red Docker (público opcional) | `demo-protege` (mock del canal WhatsApp) |
| 8081 | `127.0.0.1` | panel OSINT (servicio habilitado pero sin arrancar) |

CUPS (631) viene con los snaps de la imagen base y no sirve de nada en un VPS: desinstálalo.

---

# Procedimiento de réplica

## Paso 0 — Provisionar el VPS

Ubuntu 24.04 LTS, mínimo 2 vCPU / 4 GB RAM / 80 GB. Acceso root por clave SSH.

```bash
apt-get update && apt-get -y upgrade
timedatectl set-timezone America/Bogota   # el contenedor n8n usa GENERIC_TIMEZONE
apt-get install -y curl git ca-certificates gnupg jq rsync ufw
```

Swap de 4 GB (idéntico al original):

```bash
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Firewall — obligatorio, con allowlist estricta:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 8090/tcp     # landing
ufw allow 8099/tcp     # demo Guardian
ufw allow 5678/tcp     # n8n
ufw allow 9000/tcp     # protege-api  (omite esta regla si sólo la consume el backend por red Docker)
# NO abras 5432: Postgres no debe quedar público. Ver Paso 6.
ufw enable
```

## Paso 1 — Docker

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
```

No hay `/etc/docker/daemon.json` en el original: se deja la configuración por defecto.

## Paso 2 — Runtimes del host

```bash
# Node 22 + npm
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm i -g pm2@7.0.3 @anthropic-ai/claude-code

# Bun
curl -fsSL https://bun.sh/install | bash

# nginx
apt-get install -y nginx
systemctl enable --now nginx

# ttyd
apt-get install -y ttyd

# cloudflared
curl -fsSL -o /usr/local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /usr/local/bin/cloudflared

# Go 1.24.5 — sólo si vas a recompilar el CLI Secura
curl -fsSL https://go.dev/dl/go1.24.5.linux-amd64.tar.gz | tar -C /usr/local -xz
echo 'export PATH=$PATH:/usr/local/go/bin' >> /root/.bashrc
```

Python 3.12 ya viene en Ubuntu 24.04.

## Paso 3 — Clonar repositorios

```bash
cd /root
git clone https://github.com/FilipaoVfx/hackatonv2Colsubsidio.git hackaton-sync
git clone https://github.com/Tovar-D3v/colsubsidio-seguros-api.git
git clone https://github.com/FilipaoVfx/botRepos.git
git clone https://github.com/FilipaoVfx/landingHackaton30x.git
git clone https://github.com/FilipaoVfx/landingHackaton30x.git landing-deploy
git clone https://github.com/FilipaoVfx/operacionColombia
git clone https://github.com/Panniantong/Agent-Reach.git
git clone https://gitlab.com/indexerdevops/indexerdevops.git
git clone https://github.com/Ekaanth/OpenCut-AI
git -C operacionColombia checkout feat/ola1-connector-engine
```

Guardian desplegado (desde el subdirectorio del monorepo del hackatón):

```bash
cp -a /root/hackaton-sync/guardian-ai /root/guardian-ai
cd /root/guardian-ai && git init && git add -A && git commit -m "chore: snapshot desplegado"
```

Copia de trabajo del landing:

```bash
cp -a /root/landingHackaton30x /root/guardian-ia-landing
rm -rf /root/guardian-ia-landing/.git
```

`/root/monitoring` no tiene repo: cópialo por rsync del host original, o recréalo a partir de `/root/indexerdevops/observability` (mismos servicios, versiones pineadas).

## Paso 4 — Secretos

Ningún `.env` está versionado. Hay que rellenarlos a mano; los `.env.example` documentan cada clave.

**`/root/guardian-ai/.env`** (plantilla: `/root/guardian-ai/.env.example`):

```
OPENAI_API_KEY=            # obligatorio: motor de conversación GPT-4o
ELEVENLABS_API_KEY=        # TTS; sin esto el dashboard usa Web Speech
ELEVENLABS_VOICE_ID=
VAPI_API_KEY=              # telefonía — usar la PRIVATE key
VAPI_PHONE_ID=
VAPI_PUBLIC_KEY=
VAPI_ASSISTANT_ID=
SUPABASE_URL=
SUPABASE_DB_URL=           # usar el POOLER IPv4, no el host directo
KAPSO_API_KEY=             # canal WhatsApp (opcional: sin esto corre modo demo)
KAPSO_PHONE_NUMBER_ID=
KAPSO_WEBHOOK_SECRET=
PUBLIC_BASE_URL=           # URL pública HTTPS del túnel, para el webhook Kapso
OPENROUTER_API_KEY=
OPENROUTER_MODEL=
```

**`/root/botRepos/.env`**: `PORT`, `MAX_BATCH_SIZE`, `ALLOWED_ORIGINS`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PINECONE_API_KEY`, `PINECONE_INDEX`, `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL`, `TELEGRAM_BOT_TOKEN`, `HOST_LABEL`, `SCRAPER_TECH_KEY`.

**`/root/colsubsidio-seguros-api/.env`**: `APP_NAME`, `ENVIRONMENT`, `API_PREFIX`, `DATABASE_URL`.

> **Seguridad:** el `TELEGRAM_BOT_TOKEN`, las claves de OpenAI/Pinecone/Supabase y la `SERVICE_ROLE_KEY` son secretos vivos. Transfiérelos por un canal cifrado (gestor de contraseñas o `scp` directo), nunca por chat ni en un repo. Si el VPS nuevo es de otra persona u otro entorno, **rota las claves** en lugar de copiarlas.

## Paso 5 — Stack Guardian AI

`/root/guardian-ai/docker-compose.yml` (el desplegado; difiere del que trae el repo):

- `backend` — build de `./backend` (Go 1.22 multi-stage → alpine). `env_file: .env`, `STEP_MS=450`, `COLSUBSIDIO_API_URL` (default `http://demo-protege:9000`), `STUDIO_API_URL` (default `http://studio-mock:9000`). Volumen `guardian-config:/var/lib/guardian`. Expone 3000 sólo en la red interna.
- `demo-protege` — build de `./mock-protege`, publicado en `9002:9000`. Es el cerebro del canal WhatsApp de la demo (21 productos del portafolio real).
- `studio-mock` — build de `./mock-protege`, **sin puerto**. Aislado a propósito: el Playground crea usuarios de ensayo que no pueden mezclarse con datos reales.
- `mock-protege` — bajo `profiles: ["mock"]`, apagado. Sólo para desarrollo offline (`docker compose --profile mock up`, puerto host 9001).
- `nginx` — `nginx:1.24-alpine`, `8099:80`, monta `./nginx/nginx.conf` y `./frontend/dist`.

Build y arranque:

```bash
cd /root/guardian-ai/frontend && npm ci && npm run build     # genera frontend/dist (React + Vite + HeroUI)
cd /root/guardian-ai && docker compose up -d --build
```

El `nginx.conf` interno usa `resolver 127.0.0.11 valid=10s` con el upstream en variable (`set $backend backend;`), para que un rebuild del backend no deje el proxy en 502. Rutas: `/` → SPA con fallback a `index.html`, `/api/` → backend:3000, `/ws` → backend:3000 con upgrade WebSocket y `proxy_read_timeout 3600s`.

## Paso 6 — API y base de datos Protege (fuera de compose)

Estos dos contenedores se crearon a mano en el original. Reprodúcelos **después** de que exista la red `guardian-ai_default` (la crea el compose del paso anterior).

```bash
# 6.1 Volumen con nombre (el original usa uno anónimo — esto lo corrige)
docker volume create protege-db-data

# 6.2 PostgreSQL 16
docker run -d --name protege-db \
  --restart unless-stopped \
  -e POSTGRES_USER=protege \
  -e POSTGRES_PASSWORD='<CONTRASEÑA_FUERTE>' \
  -e POSTGRES_DB=protege \
  -p 127.0.0.1:5432:5432 \
  -v protege-db-data:/var/lib/postgresql/data \
  postgres:16-alpine
docker network connect guardian-ai_default protege-db

# 6.3 Build e inicio de la API real (FastAPI)
cd /root/colsubsidio-seguros-api
docker build -t colsubsidio-protege-api .
docker run -d --name protege-api \
  --restart unless-stopped \
  --network guardian-ai_default \
  --network-alias mock-protege \
  -e DATABASE_URL='postgresql+psycopg://protege:<CONTRASEÑA_FUERTE>@protege-db:5432/protege' \
  -p 9000:9000 \
  colsubsidio-protege-api
```

Tres detalles que hay que respetar o el stack se rompe:

1. **`--network-alias mock-protege`** — el backend de Guardian resuelve la API por ese nombre. Sin el alias, `COLSUBSIDIO_API_URL=http://mock-protege:9000` apunta a la nada.
2. **`-p 127.0.0.1:5432:5432`** — Postgres atado a loopback. Publicarlo en `0.0.0.0` deja la base accesible desde internet; la API llega igual por la red Docker, así que no hay motivo para exponerlo.
3. **`--restart unless-stopped`** en la base de datos. Con el default (`no`) el contenedor no vuelve tras un reboot y el stack arranca sin persistencia.

La imagen incluye `HEALTHCHECK` sobre `/health` y `docker-entrypoint.sh` (corre migraciones Alembic antes de arrancar uvicorn).

Si prefieres apuntar Guardian al mock en vez de a la API real, pon en `.env`: `COLSUBSIDIO_API_URL=http://demo-protege:9000` y no levantes `protege-api`.

## Paso 7 — n8n

Creado con `docker run`, sin compose:

```bash
docker volume create n8n_data
docker run -d --name n8n \
  --restart unless-stopped \
  -p 5678:5678 \
  -e GENERIC_TIMEZONE=America/Bogota \
  -e TZ=America/Bogota \
  -v n8n_data:/home/node/.n8n \
  docker.n8n.io/n8nio/n8n:latest
```

Los workflows y credenciales viven **sólo** en el volumen `n8n_data`. Para migrarlos, ver §11.

## Paso 8 — Landing estático (nginx :8090)

```bash
cd /root/guardian-ia-landing && npm ci && npm run build   # tsc -b && vite build
mkdir -p /var/www/guardian-ia-landing
rsync -a --delete /root/guardian-ia-landing/dist/ /var/www/guardian-ia-landing/
```

`/etc/nginx/sites-available/guardian-ia-landing`:

```nginx
# Guardian IA · Colsubsidio — landing estática (build Vite en /var/www/guardian-ia-landing)
server {
    listen 8090;
    listen [::]:8090;
    server_name _;

    root /var/www/guardian-ia-landing;
    index index.html;

    gzip on;
    gzip_types text/css application/javascript image/svg+xml font/woff2;
    gzip_min_length 1024;

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/guardian-ia-landing /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

`/etc/nginx/conf.d/` está vacío y el `default` de Ubuntu está deshabilitado (no hay symlink en `sites-enabled`).

## Paso 9 — Servicios systemd

Crea los cuatro units tal cual el original.

`/etc/systemd/system/cloudflared-guardian.service`:

```ini
[Unit]
Description=Cloudflare quick tunnel -> guardian-ai demo (localhost:8099)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared tunnel --url http://localhost:8099 --no-autoupdate
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/cloudflared-tunnel.service`:

```ini
[Unit]
Description=Cloudflare Tunnel (Quick Tunnel) — botRepos Dashboard
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared tunnel --url http://localhost:8787
Restart=always
RestartSec=5
User=root
Nice=10

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/osint-panel.service` (habilitado pero **inactivo** en el original — replícalo igual y decide si lo arrancas):

```ini
[Unit]
Description=Operacion Colombia - Read API + panel OSINT unificado (Node)
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/operacionColombia
Environment=PORT=8081
Environment=NODE_ENV=production
ExecStart=/usr/bin/node apps/api/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

`/etc/default/ttyd`:

```
TTYD_OPTIONS="-i lo -p 7681 -O login"
```

```bash
systemctl daemon-reload
systemctl enable --now cloudflared-guardian cloudflared-tunnel ttyd
systemctl enable osint-panel          # habilitado sin arrancar, igual que el original
```

## Paso 10 — PM2

```bash
cd /root/botRepos && npm ci
pm2 start ecosystem.config.cjs                    # telegram-rag-bot

cd /root/guardian-ia-landing
pm2 start bash --name guardian-preview -- -c "npx vite preview --port 4173 --host 127.0.0.1"

cd /root/guardian-ai/cli
go build -o bin/secura .                          # requiere Go 1.24.5
pm2 start ./scripts/web-terminal.sh --name secura-ttyd --interpreter bash

mkdir -p /root/.secura
cd /root/landing-deploy
pm2 start /usr/local/bin/cloudflared --name secura-api-tunnel -- \
  tunnel --url http://localhost:8099 --no-autoupdate --logfile /root/.secura/secura-api-tunnel.log
pm2 start /usr/local/bin/cloudflared --name secura-ttyd-tunnel -- \
  tunnel --url http://localhost:7682 --no-autoupdate --logfile /root/.secura/secura-ttyd-tunnel.log

pm2 save
pm2 startup systemd -u root --hp /root            # genera pm2-root.service
```

`web-terminal.sh` expone el TUI Secura en `127.0.0.1:7682` con `--read-only` y `--max-clients 10`, ejecutando el binario directamente (sin shell, para que no haya escape a bash). El flag `--read-only` **no es opcional**: la sesión es pública y los módulos Settings/Prompt pueden publicar y revertir la configuración del agente en producción.

Cron:

```bash
mkdir -p /root/botRepos/logs
( crontab -l 2>/dev/null; echo '0 4 * * * /root/botRepos/ingest.sh >> /root/botRepos/logs/ingest.log 2>&1' ) | crontab -
```

## Paso 11 — Stacks opcionales (apagados en el original)

Sólo levántalos si los necesitas; consumen RAM que el host original no tiene.

```bash
# Monitoring: Prometheus :9090, Grafana :3000, node-exporter :9100, blackbox :9115
cd /root/monitoring && docker compose up -d
# Requiere /etc/prometheus/secrets en el host (montado read-only por el compose).

# OpenCut-AI: web :3100, ai-backend :8420, ollama :11434, postgres :5432, redis :6380,
# whisper/tts/image/speaker/face/clip/turboquant :8421-8430.
# Descarga varios GB de modelos. Red propia 172.28.0.0/16. NO CABE en 1 vCPU / 2 GB.
cd /root/OpenCut-AI && cp .env.example .env && docker compose up -d

# SonarQube (nunca levantado aquí): choca con protege-api en el puerto 9000.
cd /root/indexerdevops/sonarqube && docker compose up -d sonarqube
```

**Conflicto de puertos a vigilar:** Grafana (3000), OpenCut postgres (5432) y SonarQube (9000) chocan con servicios ya activos en este host. Si levantas Monitoring y OpenCut a la vez, remapea uno de los dos `5432`.

---

## 11. Migración de datos con estado

El código se reconstruye desde los repos; **los datos no**. Antes de apagar el VPS viejo:

```bash
### En el VPS ORIGEN

# n8n (workflows + credenciales)
docker run --rm -v n8n_data:/data -v /root/backup:/backup alpine \
  tar czf /backup/n8n_data.tgz -C /data .

# Postgres Protege
docker exec protege-db pg_dump -U protege protege > /root/backup/protege.sql

# Config del Agent Studio
docker run --rm -v guardian-ai_guardian-config:/data -v /root/backup:/backup alpine \
  tar czf /backup/guardian-config.tgz -C /data .

# Grafana + Prometheus (si te importan los dashboards y las series)
docker run --rm -v monitoring_grafana-data:/data -v /root/backup:/backup alpine \
  tar czf /backup/grafana-data.tgz -C /data .

# Ficheros sin repo
tar czf /root/backup/sin-repo.tgz /root/monitoring /root/guardian-ia-landing/src \
  /root/guardian-ai/.env /root/botRepos/.env /root/colsubsidio-seguros-api/.env
```

```bash
### En el VPS DESTINO (tras el Paso 7)

rsync -avz root@<VPS_IP>:/root/backup/ /root/backup/

docker run --rm -v n8n_data:/data -v /root/backup:/backup alpine \
  tar xzf /backup/n8n_data.tgz -C /data
docker restart n8n

cat /root/backup/protege.sql | docker exec -i protege-db psql -U protege protege

docker run --rm -v guardian-ai_guardian-config:/data -v /root/backup:/backup alpine \
  tar xzf /backup/guardian-config.tgz -C /data
docker restart guardian-ai-backend-1
```

Atajo de alta fidelidad para Guardian, que evita reconstruir a mano las diferencias entre el repo y lo desplegado:

```bash
rsync -avz --exclude node_modules --exclude .git \
  root@<VPS_IP>:/root/guardian-ai/ /root/guardian-ai/
```

---

## 12. Verificación post-réplica

```bash
# 8 contenedores en ejecución (7 si omites guardian-fallback-test)
docker ps --format '{{.Names}}\t{{.Status}}'

# Guardian responde
curl -sf http://localhost:8099/ | head -5
curl -sf http://localhost:8099/api/health || curl -s http://localhost:8099/api/status

# API Protege sana
curl -sf http://localhost:9000/health

# El alias de red resuelve desde el backend  ← el fallo más común
docker exec guardian-ai-backend-1 wget -qO- http://mock-protege:9000/health

# Mock del canal WhatsApp
curl -sf http://localhost:9002/health

# n8n
curl -sI http://localhost:5678 | head -1

# Landing
curl -sI http://localhost:8090 | head -1

# PM2: 5 procesos online
pm2 list

# systemd
systemctl is-active cloudflared-guardian cloudflared-tunnel ttyd nginx docker

# URL pública del túnel Guardian
journalctl -u cloudflared-guardian -n 50 --no-pager | grep -o 'https://.*trycloudflare.com'
```

Checklist funcional: la SPA carga en `:8099`, el WebSocket `/ws` conecta (dashboard en vivo), el chat de WhatsApp responde vía `demo-protege`, y el CLI Secura abre en `:7682` en modo read-only.

---

## 13. Checklist de endurecimiento

Estos puntos son parte del procedimiento, no opcionales. Son los que un despliegue hecho a las prisas suele saltarse:

| Punto | Qué hacer | Motivo |
|---|---|---|
| Firewall | `ufw` activo con allowlist explícita | sin él, cada `-p` en `0.0.0.0` queda abierto a internet |
| PostgreSQL | atar a `127.0.0.1`, contraseña fuerte | la base no tiene ninguna razón para ser pública |
| Persistencia | volumen con nombre (`protege-db-data`), no anónimo | un `docker rm` descuidado borra los datos |
| Reinicio | `--restart unless-stopped` en DB y API | el stack debe volver solo tras un reboot |
| Disco | 80 GB mínimo | los builds y los modelos de IA llenan 48 GB |
| Snaps | desinstalar CUPS | servicio de impresión inútil en un VPS |
| Túneles | un solo túnel por destino (systemd **o** PM2) | duplicarlos confunde el diagnóstico |
| SSH | preferir un usuario no-root con `sudo` y `PermitRootLogin prohibit-password` | reduce la superficie de ataque |
| Contenedores de prueba | no replicar `guardian-fallback-test` | es un experimento ad-hoc, no parte del stack |

## 14. Errores frecuentes al replicar

1. **Olvidar `--network-alias mock-protege`** en `protege-api`. El backend arranca sin quejarse pero el flujo WhatsApp cae al fallback GPT.
2. **Levantar `protege-api` antes que el compose de Guardian.** La red `guardian-ai_default` aún no existe → `docker run` falla.
3. **Publicar `frontend/dist` sin construirlo.** nginx sirve un 403/404: `npm run build` es obligatorio antes de `docker compose up`.
4. **Copiar `/root/guardian-ai` desde `hackaton-sync` sin ajustar el compose.** Los dos ficheros difieren; el bueno es el del host (§6.1).
5. **Perder el volumen `n8n_data`.** Los workflows no están en ningún repo — sólo ahí.
6. **Choque de puertos** al levantar Monitoring (Grafana :3000) u OpenCut (:5432) junto al stack base.
7. **`docker compose up` sin `.env`.** El backend arranca en modo degradado y sin `OPENAI_API_KEY` no hay conversación real.
