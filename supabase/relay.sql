-- 암각화몬 이어 그리기 (relay game) rooms. Run in the Supabase SQL editor after schema.sql.
-- Only the server touches these tables, with the service-role key (SUPABASE_SERVICE_ROLE_KEY).
-- RLS is on with no policies, so the anon key can neither read nor write them
-- (player rows hold secret tokens). Rooms older than a day are deleted by the server.

create table if not exists public.relay_rooms (
  code        text primary key check (code ~ '^[A-Z]{4}$'),
  created_at  timestamptz not null default now(),
  -- shared/relay.ts RoomState; `version` makes updates compare-and-set
  state       jsonb not null,
  version     integer not null default 0
);

create table if not exists public.relay_players (
  room    text not null references public.relay_rooms (code) on delete cascade,
  id      text not null,
  token   text not null,
  name    text not null check (char_length(name) <= 10),
  seat    smallint not null default -1,
  joined  bigint not null,
  seen    bigint not null,
  primary key (room, id)
);

create table if not exists public.relay_entries (
  room     text not null references public.relay_rooms (code) on delete cascade,
  game     integer not null,
  chain    smallint not null,
  step     smallint not null,
  author   text not null,
  text     text check (text is null or char_length(text) <= 40),
  drawing  jsonb check (drawing is null or pg_column_size(drawing) < 400000),
  auto     boolean not null default false,
  primary key (room, game, chain, step)
);

alter table public.relay_rooms enable row level security;
alter table public.relay_players enable row level security;
alter table public.relay_entries enable row level security;

-- Newer Supabase projects do not grant tables created in SQL to the API roles automatically.
-- Only the server's service role may use these tables (the anon key gets no grant at all).
grant select, insert, update, delete on public.relay_rooms, public.relay_players, public.relay_entries to service_role;
