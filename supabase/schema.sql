-- Tagged: shared AR graffiti. Paste this whole file into the Supabase SQL editor and run it.
-- Auth: Supabase email/password. A real painter row's id IS the auth user id (seeded painters
-- just get random ids and can't log in); writes are gated on
-- auth.uid() so a piece is always signed by whoever is logged in. Reads are public.
-- Tip for the demo: Authentication → Providers → Email → turn OFF "Confirm email" so sign-up
-- logs straight in (otherwise the user must tap the emailed link first).

create extension if not exists pgcrypto;

create table if not exists painters (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  device_id text,
  paint_used double precision not null default 0,
  strokes integer not null default 0,
  created_at timestamptz not null default now()
);

-- A canvas is a virtual wall anchored to where its author stood (lat/lng) and the
-- compass heading they were facing. Strokes are stored in angular coordinates
-- (yaw degrees relative to `heading`, pitch degrees from the horizon).
create table if not exists canvases (
  id uuid primary key default gen_random_uuid(),
  lat double precision not null,
  lng double precision not null,
  heading double precision not null,
  title text,
  author_id uuid references painters(id),
  author_name text not null,
  views integer not null default 0,
  stroke_count integer not null default 0,
  flags integer not null default 0,
  flagged boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists strokes (
  id uuid primary key default gen_random_uuid(),
  canvas_id uuid not null references canvases(id) on delete cascade,
  author_id uuid references painters(id),
  author_name text not null,
  color text not null,
  cap text not null default 'fat',
  -- [[yaw, pitch, size, alpha], ...] in canvas-relative degrees
  points jsonb not null,
  paint_used double precision not null default 0,
  created_at timestamptz not null default now()
);
-- (migration for databases created from an earlier version of this file)
alter table painters alter column id set default gen_random_uuid();
alter table painters drop constraint if exists painters_id_fkey;

create index if not exists strokes_canvas_idx on strokes(canvas_id, created_at);

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  canvas_id uuid not null references canvases(id) on delete cascade,
  reporter_id uuid references painters(id),
  reason text,
  created_at timestamptz not null default now()
);

-- Light moderation: 2 reports hides a canvas from everyone.
create or replace function on_report() returns trigger language plpgsql as $$
begin
  update canvases set flags = flags + 1, flagged = (flags + 1) >= 2 where id = new.canvas_id;
  return new;
end $$;
drop trigger if exists reports_flag on reports;
create trigger reports_flag after insert on reports for each row execute function on_report();

-- Keep counters + leaderboard stats in sync on every stroke.
create or replace function on_stroke() returns trigger language plpgsql as $$
begin
  update canvases set stroke_count = stroke_count + 1, updated_at = now() where id = new.canvas_id;
  if new.author_id is not null then
    update painters set strokes = strokes + 1, paint_used = paint_used + coalesce(new.paint_used, 0)
      where id = new.author_id;
  end if;
  return new;
end $$;
drop trigger if exists strokes_counters on strokes;
create trigger strokes_counters after insert on strokes for each row execute function on_stroke();

create or replace function increment_views(cid uuid) returns integer language sql security definer as $$
  update canvases set views = views + 1 where id = cid returning views;
$$;

-- Haversine proximity query (meters). Good enough for a campus.
create or replace function nearby_canvases(qlat double precision, qlng double precision, radius_m double precision)
returns setof canvases language sql stable as $$
  select * from canvases c
  where not c.flagged and
    2 * 6371000 * asin(sqrt(
      power(sin(radians(c.lat - qlat) / 2), 2) +
      cos(radians(qlat)) * cos(radians(c.lat)) * power(sin(radians(c.lng - qlng) / 2), 2)
    )) <= radius_m
  order by c.created_at desc;
$$;

alter table painters enable row level security;
alter table canvases enable row level security;
alter table strokes enable row level security;
alter table reports enable row level security;

drop policy if exists "anon all painters" on painters;
drop policy if exists "anon all canvases" on canvases;
drop policy if exists "anon all strokes" on strokes;
drop policy if exists "anon all reports" on reports;
drop policy if exists "read painters" on painters;
drop policy if exists "own painter" on painters;
drop policy if exists "read canvases" on canvases;
drop policy if exists "create canvas" on canvases;
drop policy if exists "read strokes" on strokes;
drop policy if exists "create stroke" on strokes;
drop policy if exists "delete own stroke" on strokes;
drop policy if exists "create report" on reports;

create policy "read painters" on painters for select using (true);
create policy "own painter" on painters for all using (auth.uid() = id) with check (auth.uid() = id);
create policy "read canvases" on canvases for select using (true);
create policy "create canvas" on canvases for insert with check (auth.uid() = author_id);
create policy "read strokes" on strokes for select using (true);
create policy "create stroke" on strokes for insert with check (auth.uid() = author_id);
-- Undo in the app deletes the stroke you just painted; only its author may.
create policy "delete own stroke" on strokes for delete using (auth.uid() = author_id);
create policy "create report" on reports for insert with check (auth.uid() = reporter_id);

-- Triggers update counters on tables the caller can't update directly.
alter function on_stroke() security definer;
alter function on_report() security definer;

-- Realtime for live multi-phone painting.
do $$ begin
  alter publication supabase_realtime add table strokes;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table canvases;
exception when duplicate_object then null; end $$;
