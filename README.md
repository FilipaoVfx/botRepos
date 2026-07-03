# botRepos — Telegram RAG Bot

Bot de Telegram + CLI que hace **búsqueda semántica (RAG)** sobre una base de
conocimiento de *bookmarks* y *READMEs de repositorios de GitHub*.

- **Embeddings:** OpenAI (`text-embedding-3-small`, 1536 dims)
- **Base vectorial:** Pinecone
- **Metadatos / fuente de verdad:** Supabase (Postgres)
- **Interfaces:** bot de Telegram, CLI de búsqueda, script de ingesta

```
Usuario ─► Telegram / CLI
                │
                ▼
        rag-orchestrator.js ──► OpenAI (embed query)
                │                └► Pinecone (queryVectors, topK)
                ▼
        Supabase (enriquecer resultados + log)
                │
                ▼
          Resultados formateados
```

## Componentes

| Archivo | Rol |
|---|---|
| `src/telegram-bot.js` | Bot de Telegram (`/search`, `/filter`, texto libre, menciones) |
| `src/rag-orchestrator.js` | Núcleo de búsqueda + CLI (`npm run search -- "query"`) |
| `src/rag-pinecone.js` | Wrapper de Pinecone (query / upsert / delete / stats) |
| `src/rag-openai.js` | Generación de embeddings |
| `src/rag-ingest.js` | Ingesta: Supabase → chunks → embeddings → Pinecone |
| `src/rag-chunking.js` | Chunking y saneado de texto |

## Arranque rápido (local)

```bash
npm install
cp .env.example .env        # y rellena tus claves
npm run ingest              # (opcional) carga/actualiza el índice Pinecone
npm start                   # arranca el bot
npm run search -- "react hooks patterns"   # prueba la CLI
```

## Despliegue en VPS 24/7

Ver **[DEPLOY.md](DEPLOY.md)** — guía completa (Node, PM2, systemd, cron de
ingesta, Pinecone, tablas de Supabase, troubleshooting).

## Variables de entorno

Ver `.env.example`. Resumen:

| Variable | Requerida | Default |
|---|---|---|
| `SUPABASE_URL` | ✅ | — |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ (o `SUPABASE_ANON_KEY`) | — |
| `PINECONE_API_KEY` | ✅ | — |
| `PINECONE_INDEX` | — | `indexbook-knowledge` |
| `OPENAI_API_KEY` | ✅ | — |
| `OPENAI_EMBEDDING_MODEL` | — | `text-embedding-3-small` |
| `TELEGRAM_BOT_TOKEN` | ✅ (para el bot) | — |

> ⚠️ **Nunca** subas `.env` al repo. Ya está en `.gitignore`.
