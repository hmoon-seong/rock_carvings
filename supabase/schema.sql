-- 암각화몬 shared wall: one table. Run in the Supabase SQL editor (Dashboard → SQL → New query).
-- Anonymous clients may read and insert rows only; no update, no delete.
-- The visitor's message is never stored (it is only moderated).

create table if not exists public.carvings (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  -- where it sits on the wall, mm, origin top-left (public/wall/metadata.json: 10412 × 4650 mm)
  x_mm        real not null,
  y_mm        real not null,
  w_mm        real not null check (w_mm between 40 and 3000),
  h_mm        real not null check (h_mm between 40 and 3000),
  -- the stroke frame: strokes are in mm of a src_w × src_h box, scaled to w_mm × h_mm on the wall
  src_w       real not null check (src_w > 0 and src_w <= 3000),
  src_h       real not null check (src_h > 0 and src_h <= 3000),
  -- [{ c: color index (-1 = eraser), s: brush mm, seed: int, p: [x0, y0, x1, y1, …] }]
  strokes     jsonb not null check (jsonb_typeof(strokes) = 'array' and pg_column_size(strokes) < 400000),
  -- the removed challenge mode (2026-10-27); new rows leave them null
  prompt      text check (prompt is null or char_length(prompt) <= 40),
  score       smallint check (score is null or score between 0 and 100),
  -- old 이어 그리기 rows (a chain's drawings in a row; number of players); no longer written (2026-10-29)
  relay       smallint check (relay is null or relay between 2 and 8)
);

-- For a table created before 이어 그리기:
alter table public.carvings add column if not exists relay smallint check (relay is null or relay between 2 and 8);

create index if not exists carvings_pos on public.carvings (x_mm, y_mm);
create index if not exists carvings_created on public.carvings (created_at desc);

alter table public.carvings enable row level security;

drop policy if exists "anyone can read carvings" on public.carvings;
create policy "anyone can read carvings" on public.carvings
  for select to anon, authenticated using (true);

drop policy if exists "anyone can add a carving" on public.carvings;
create policy "anyone can add a carving" on public.carvings
  for insert to anon with check (true);

-- No update/delete policies: with RLS on, those are denied for anon.
-- To remove a carving, use the dashboard (Table editor) or the service role.

-- The wall keeps only the 30 newest carvings (shared/wall.ts → WALL_MAX): each insert deletes
-- the older ones. Security definer, so it may delete although anon may not.
create or replace function public.carvings_keep_newest() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.carvings
  where id not in (select id from public.carvings order by created_at desc, id desc limit 30);
  return null;
end $$;

drop trigger if exists carvings_keep_newest on public.carvings;
create trigger carvings_keep_newest after insert on public.carvings
  for each statement execute function public.carvings_keep_newest();

-- Newer Supabase projects do not grant tables created in SQL to the API roles automatically.
-- (Row-level security above still decides which rows; these only open the table at all.)
grant select, insert on public.carvings to anon;
grant select, insert, update, delete on public.carvings to service_role;
