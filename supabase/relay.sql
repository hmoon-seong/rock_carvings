-- 암각화몬 이어 그리기 (relay game) rooms. Run in the Supabase SQL editor after schema.sql.
-- Only the server touches these tables, with the service-role key (SUPABASE_SERVICE_ROLE_KEY).
-- RLS is on with no policies, so the anon key can neither read nor write them
-- (player rows hold secret tokens). The server deletes rooms older than a day and empty rooms
-- (nobody seen for 2 minutes) through relay_cleanup() below.
--
-- Safe to run again on an existing database (it only adds what is missing). To delete the
-- empty rooms right away, run afterwards:   select public.relay_cleanup();

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
  -- 관전 (watcher): in the room, not in the game
  watch   boolean not null default false,
  primary key (room, id)
);
alter table public.relay_players add column if not exists watch boolean not null default false;

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

-- Deletes rooms created more than a day ago, and rooms where no player or watcher has been
-- seen for `empty_ms` (players' `seen` is ms since epoch; rooms younger than `new_ms` are
-- kept, since the creator joins just after the room is made). Returns how many were deleted.
create or replace function public.relay_cleanup(empty_ms bigint default 120000, new_ms bigint default 60000)
returns integer
language sql
set search_path = public
as $$
  with gone as (
    delete from public.relay_rooms r
    where r.created_at < now() - interval '1 day'
       or (r.created_at < now() - make_interval(secs => new_ms / 1000.0)
           and not exists (
             select 1 from public.relay_players p
             where p.room = r.code
               and p.seen > (extract(epoch from now()) * 1000)::bigint - empty_ms))
    returning 1
  )
  select count(*)::integer from gone;
$$;

revoke execute on function public.relay_cleanup(bigint, bigint) from public, anon, authenticated;
grant execute on function public.relay_cleanup(bigint, bigint) to service_role;
