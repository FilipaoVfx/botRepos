-- repo_engagement_metrics — Trust Score (Fase 1)
--
-- Persiste las métricas de interacción de Twitter por repo y su trust_score
-- agregado (0.00–10.00). Coherente con la DB existente:
--   * FK a github_repo_readmes(repo_slug) — que ya es PRIMARY KEY (ON DELETE
--     CASCADE: si el repo desaparece del índice, sus métricas también).
--   * RLS habilitado, como el resto de tablas del proyecto (bookmarks, events,
--     github_repo_readmes, rag_queries_log). El bot escribe/lee con service_role,
--     que ignora RLS; anon/authenticated no ven nada.
--
-- Nota de layout: el requerimiento referenciaba backend/sql/016_*.sql, pero este
-- repo (botRepos) usa sql/ con numeración propia; esta es la 002 (tras 001_events).

create table if not exists public.repo_engagement_metrics (
  repo_slug            text primary key
                         references public.github_repo_readmes(repo_slug) on delete cascade,
  -- tweet padre (fuente de la métrica)
  source_url           text          not null,
  mentions_count       integer       default 1,
  -- promedios por tweet
  avg_likes            numeric(10,2) default 0,
  avg_impressions      numeric(12,2) default 0,
  avg_interactions     numeric(12,2) default 0,
  avg_saves            numeric(10,2) default 0,
  avg_shares           numeric(10,2) default 0,
  avg_replies          numeric(10,2) default 0,
  avg_reposts          numeric(10,2) default 0,
  avg_profile_visits   numeric(10,2) default 0,
  avg_url_clicks       numeric(10,2) default 0,
  avg_engagement_rate  numeric(5,2)  default 0,
  avg_like_rate        numeric(5,2)  default 0,
  -- score agregado + versión de la fórmula (para recomputar sin ambigüedad)
  trust_score          numeric(4,2)  default 0,
  trust_score_version  integer       default 1,
  -- metadata
  created_at           timestamptz   default now(),
  updated_at           timestamptz   default now()
);

create index if not exists idx_repo_engagement_trust_score
  on public.repo_engagement_metrics (trust_score desc);

alter table public.repo_engagement_metrics enable row level security;
