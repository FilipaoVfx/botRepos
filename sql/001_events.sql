-- events — per-message observability log for the Telegram RAG bot.
--
-- One row per query across every interface (telegram / telegram-repo / cli / api).
-- Captures the query and its result, phase timings, OpenAI usage/cost, and the
-- user/chat context that Telegram's Bot API exposes on `message.from` + `chat`
-- (nothing beyond the Bot API — no phone numbers, no scraping).
--
-- Run this once in the Supabase SQL editor (project alwfutrekzrklrugjaxe) before
-- deploying the code that writes to it. Written by the bot via the service_role
-- key, read by the observability dashboard.

create table if not exists public.events (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  interface      text        not null,

  -- Telegram user context (Bot API message.from / chat; null for cli/api)
  user_id        bigint,
  username       text,
  first_name     text,
  last_name      text,
  language_code  text,
  is_premium     boolean,
  is_bot         boolean,
  chat_id        bigint,
  chat_type      text,

  -- query + result
  query          text        not null,
  results_count  integer     not null default 0,
  sources        jsonb,

  -- phase timings (milliseconds)
  response_time  integer,   -- total wall time
  embedding_time integer,   -- OpenAI embedding call
  retrieval_time integer,   -- Pinecone vector query
  llm_time       integer,   -- null: retrieval-only RAG, no generative step

  -- OpenAI usage (embedding only; 0 on cache hits)
  tokens         integer,
  cost           numeric(12,8),
  model          text
);

create index if not exists events_created_at_idx on public.events (created_at desc);
create index if not exists events_user_id_idx    on public.events (user_id);

-- Lock the table down: the bot uses the service_role key (which bypasses RLS),
-- so enabling RLS with no policies means anon/authenticated clients get nothing.
alter table public.events enable row level security;
