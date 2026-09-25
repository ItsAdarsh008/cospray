-- ============================================================================
-- Fresco — one-paste backend setup. Supabase SQL Editor -> New query -> paste
-- this whole file -> Run. Safe to re-run.
--
-- Generated from, and kept identical to, the files it concatenates:
--   schema.sql             tables, triggers, RLS, RPCs, realtime
--   migration_ar.sql       the AR half: anchor_id / transform / viewer, the
--                          worldmaps bucket, set_world_map, the undo delete policy
--   migration_upvotes.sql  upvotes table + toggle_upvote / top_pieces
--   migration_security.sql report weighting, locked counters, view dedupe, limits
--   migration_worldmaps_owned.sql  world maps writable only in the uploader's folder
--   migration_strokes_v2.sql       binary stroke points (points_bin)
--   migration_geo.sql              strokes.geo (ARCore Geospatial pose)
--   seed.sql               optional demo pieces around E7
-- Edit those files, not this one: scripts/gen_setup_sql.mjs rebuilds it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1/8  schema.sql
-- ----------------------------------------------------------------------------

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

-- ----------------------------------------------------------------------------
-- 2/8  migration_ar.sql
-- ----------------------------------------------------------------------------

-- AR anchoring: strokes now carry their ARKit anchor + transform, canvases carry a saved ARWorldMap.
-- Run once after schema.sql (safe to re-run).
alter table canvases add column if not exists world_map_path text;
alter table canvases add column if not exists world_map_updated_at timestamptz;
alter table strokes add column if not exists anchor_id text;
alter table strokes add column if not exists transform jsonb;

-- world maps live in a public storage bucket
insert into storage.buckets (id, name, public) values ('worldmaps', 'worldmaps', true)
on conflict (id) do update set public = true;
drop policy if exists "worldmaps read" on storage.objects;
drop policy if exists "worldmaps write" on storage.objects;
create policy "worldmaps read" on storage.objects for select using (bucket_id = 'worldmaps');
create policy "worldmaps write" on storage.objects for insert to authenticated with check (bucket_id = 'worldmaps');
drop policy if exists "worldmaps update" on storage.objects;
create policy "worldmaps update" on storage.objects for update to authenticated using (bucket_id = 'worldmaps');

-- Any signed-in painter may replace a canvas's world map (last writer wins) — but only that column.
drop policy if exists "update canvas map" on canvases;
create or replace function set_world_map(cid uuid, path text) returns void
language sql security definer set search_path = public as $$
  update canvases set world_map_path = path, world_map_updated_at = now() where id = cid;
$$;
revoke all on function set_world_map(uuid, text) from public;
grant execute on function set_world_map(uuid, text) to authenticated;

-- AR strokes may record where the painter stood (camera world position, same frame as `transform`)
-- so other clients can project the stroke as seen from that spot rather than from the session origin.
alter table strokes add column if not exists viewer jsonb;

-- Undo: the painter may delete their own stroke (without this, undo only takes the paint off
-- the painter's own phone and the stroke stays on everyone else's).
drop policy if exists "delete own stroke" on strokes;
create policy "delete own stroke" on strokes for delete using (auth.uid() = author_id);

-- ----------------------------------------------------------------------------
-- 3/8  migration_upvotes.sql
-- ----------------------------------------------------------------------------

-- Upvotes on pieces (a piece = one canvas, never a single stroke).
--
-- PURELY ADDITIVE. Adds one column to canvases and one new table; touches no existing
-- column, policy, trigger or function on canvases, strokes, painters or reports.
--
-- Paste into the Supabase SQL editor AFTER schema.sql. Re-runnable, like seed.sql.
--
-- One vote per painter per canvas, toggleable. The composite primary key IS the
-- double-vote guard, so no client can get it wrong. canvases.upvotes is a
-- denormalised counter kept in sync by a trigger, the same shape as reports -> flags,
-- so the leaderboard is one indexed read instead of a counting join.

alter table canvases add column if not exists upvotes integer not null default 0;

create table if not exists upvotes (
  canvas_id uuid not null references canvases(id) on delete cascade,
  painter_id uuid not null references painters(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (canvas_id, painter_id)
);

create index if not exists upvotes_painter_idx on upvotes(painter_id);
create index if not exists canvases_upvotes_idx on canvases(upvotes desc);

-- Keep canvases.upvotes in step with the rows, in both directions.
-- security definer: canvases has select and insert policies but no update policy, so a trigger
-- running as the caller would match zero rows under RLS and silently fail to move the counter.
-- increment_views() solves the same problem the same way.
create or replace function on_upvote() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update canvases set upvotes = upvotes + 1 where id = new.canvas_id;
    return new;
  else
    update canvases set upvotes = greatest(0, upvotes - 1) where id = old.canvas_id;
    return old;
  end if;
end $$;

drop trigger if exists upvotes_count_ins on upvotes;
create trigger upvotes_count_ins after insert on upvotes for each row execute function on_upvote();
drop trigger if exists upvotes_count_del on upvotes;
create trigger upvotes_count_del after delete on upvotes for each row execute function on_upvote();

alter table upvotes enable row level security;

-- Votes are public so the UI can show whether you have already voted; you may only
-- add or remove your own.
drop policy if exists "read upvotes" on upvotes;
create policy "read upvotes" on upvotes for select using (true);
drop policy if exists "own upvote" on upvotes;
create policy "own upvote" on upvotes for all using (auth.uid() = painter_id) with check (auth.uid() = painter_id);

-- One round trip for the whole toggle, and it cannot race with itself: returns the
-- new count and whether the caller now has a vote on this piece.
create or replace function toggle_upvote(cid uuid)
returns table (new_count integer, voted boolean)
language plpgsql security invoker as $$
declare
  me uuid := auth.uid();
  had boolean;
begin
  if me is null then
    raise exception 'sign in to vote';
  end if;

  select exists(select 1 from upvotes u where u.canvas_id = cid and u.painter_id = me) into had;

  if had then
    delete from upvotes u where u.canvas_id = cid and u.painter_id = me;
  else
    insert into upvotes (canvas_id, painter_id) values (cid, me)
      on conflict (canvas_id, painter_id) do nothing;
  end if;

  return query
    select c.upvotes, not had from canvases c where c.id = cid;
end $$;

-- The board: the most-upvoted pieces, with whether the caller has voted on each, so
-- the list renders in one request.
create or replace function top_pieces(lim integer default 20)
returns table (
  id uuid,
  title text,
  author_id uuid,
  author_name text,
  upvotes integer,
  views integer,
  stroke_count integer,
  created_at timestamptz,
  lat double precision,
  lng double precision,
  voted boolean
)
language sql stable as $$
  select c.id, c.title, c.author_id, c.author_name, c.upvotes, c.views, c.stroke_count,
         c.created_at, c.lat, c.lng,
         exists(select 1 from upvotes u where u.canvas_id = c.id and u.painter_id = auth.uid())
  from canvases c
  where not c.flagged
  order by c.upvotes desc, c.stroke_count desc, c.created_at desc
  limit greatest(1, least(coalesce(lim, 20), 100));
$$;

-- Which of these pieces have I voted on? Used to hydrate the discovery card in bulk.
create or replace function my_upvotes(ids uuid[])
returns setof uuid language sql stable as $$
  select u.canvas_id from upvotes u
  where u.painter_id = auth.uid() and u.canvas_id = any(ids);
$$;

-- Recount from the rows, so any vote cast while the trigger was blocked is picked up and a
-- re-run always converges on the truth.
update canvases c set upvotes = coalesce(v.n, 0)
from (select canvas_id, count(*)::int as n from upvotes group by canvas_id) v
where v.canvas_id = c.id and c.upvotes is distinct from v.n;

update canvases c set upvotes = 0
where c.upvotes <> 0 and not exists (select 1 from upvotes u where u.canvas_id = c.id);

-- ----------------------------------------------------------------------------
-- 4/8  migration_security.sql
-- ----------------------------------------------------------------------------

-- Security hardening for a public launch. Run after schema.sql, migration_ar.sql and
-- migration_upvotes.sql. Re-runnable. See docs/going-public.md §0 for the why of each block.
--
-- 0.1  reports: one per person per piece, and hiding needs weighted agreement, not two taps
-- 0.2  painters: counters (paint_used, strokes) can only be moved by triggers
-- 0.3  strokes.paint_used is clamped to what the stroke could physically have used
-- 0.5  views: one per viewer per piece
-- 0.6  size caps and rate limits on strokes and canvases
--      plus: server-owned fields on insert (counters, timestamps, author_name) can't be forged

-- ---------------------------------------------------------------- 0.1 reports --

-- Duplicate reports carry no extra information; drop all but the first so the unique index fits.
delete from reports a using reports b
where a.canvas_id = b.canvas_id and a.reporter_id = b.reporter_id and a.id > b.id;
create unique index if not exists reports_one_per_reporter on reports(canvas_id, reporter_id);
-- Anonymous reports can't be weighed or deduplicated. NOT VALID: old rows stay, new ones must be signed.
do $$ begin
  alter table reports add constraint reports_reporter_required check (reporter_id is not null) not valid;
exception when duplicate_object then null; end $$;

-- How much one person's report counts. An established painter (a day old, has painted) counts
-- fully; a fresh or never-painted account counts a quarter, so a handful of throwaway accounts
-- can't hide someone's piece.
create or replace function report_weight(pid uuid) returns real
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case when p.created_at < now() - interval '1 day' and p.strokes > 0 then 1.0 else 0.25 end
    from painters p where p.id = pid
  ), 0.25)::real;
$$;

-- A piece is hidden once the weighted reports reach max(3, 2% of its views). Popular pieces need
-- proportionally more agreement. `flags` stays the raw count for the (future) review queue.
create or replace function on_report() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  w real;
  v integer;
begin
  select coalesce(sum(report_weight(r.reporter_id)), 0) into w
    from reports r where r.canvas_id = new.canvas_id and r.reporter_id is not null;
  select views into v from canvases where id = new.canvas_id;
  update canvases
     set flags = (select count(*) from reports where canvas_id = new.canvas_id),
         flagged = flagged or w >= greatest(3, ceil(coalesce(v, 0) * 0.02))
   where id = new.canvas_id;
  return new;
end $$;

-- --------------------------------------------------------------- 0.2 painters --

-- "own painter" was FOR ALL, so a painter could UPDATE their own paint_used/strokes: top of the
-- leaderboard and unlimited coins (coins = paint_used / 8) with one request.
drop policy if exists "own painter" on painters;
drop policy if exists "insert own painter" on painters;
drop policy if exists "update own painter" on painters;
create policy "insert own painter" on painters for insert
  with check (auth.uid() = id and paint_used = 0 and strokes = 0);
create policy "update own painter" on painters for update
  using (auth.uid() = id) with check (auth.uid() = id);
-- Column privileges: the app upserts {id, name}, so those two and nothing else.
revoke update on painters from anon, authenticated;
grant update (id, name) on painters to authenticated;

-- ------------------------------------------------- server-owned insert fields --

-- Canvases: counters, moderation state and timestamps start where the server says, and the
-- displayed author is the author's actual tag (author_name used to be free text: impersonation).
create or replace function canvas_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- jsonb_populate_record ignores keys the table doesn't have, so this works whether or not
  -- migration_ar.sql / migration_upvotes.sql have added their columns.
  new := jsonb_populate_record(new, jsonb_build_object(
    'views', 0, 'stroke_count', 0, 'flags', 0, 'flagged', false, 'upvotes', 0,
    'world_map_path', null, 'world_map_updated_at', null,
    'created_at', now(), 'updated_at', now()));
  if new.author_id is not null then
    select name into new.author_name from painters where id = new.author_id;
  end if;
  if new.author_name is null then new.author_name := 'anon'; end if;
  return new;
end $$;
drop trigger if exists canvases_defaults on canvases;
create trigger canvases_defaults before insert on canvases for each row execute function canvas_defaults();

-- --------------------------------------------- 0.3 + 0.6 strokes: clamp, cap, rate --

create index if not exists strokes_author_idx on strokes(author_id, created_at);
create index if not exists canvases_author_idx on canvases(author_id, created_at);

-- Number of dabs in a stroke, for either storage format (jsonb `points`, or the binary
-- `points_bin` added by migration_strokes_v2.sql, where every dab takes at least 4 bytes).
create or replace function stroke_point_count(s strokes) returns integer
language plpgsql immutable as $$
declare
  j jsonb := to_jsonb(s);
begin
  if jsonb_typeof(j -> 'points') = 'array' then return jsonb_array_length(j -> 'points'); end if;
  if j ? 'points_bin' and j ->> 'points_bin' is not null then
    -- bytea arrives in jsonb as '\x…' hex: two characters per byte
    return greatest(0, (length(j ->> 'points_bin') - 2) / 2 / 4);
  end if;
  return 0;
end $$;

create or replace function stroke_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  n integer;
  recent integer;
begin
  n := stroke_point_count(new);
  if n > 6000 then
    raise exception 'stroke too large (% dabs)', n using errcode = '22023';
  end if;
  -- A human holds one nozzle: about a stroke a second at most. 300 a minute leaves room for the
  -- offline queue (up to 120 rows in one flush) while stopping a script outright.
  if new.author_id is not null then
    select count(*) into recent from strokes
     where author_id = new.author_id and created_at > now() - interval '1 minute';
    if recent >= 300 then
      raise exception 'slow down' using errcode = '53400';
    end if;
    select name into new.author_name from painters where id = new.author_id;
  end if;
  if new.author_name is null then new.author_name := 'anon'; end if;
  -- One dab can't use more than ~0.25 paint (XL at 30 Hz is ~0.21), and one stroke empties at
  -- most one 100-unit can (the held can doesn't regenerate). paint_used feeds the leaderboard and
  -- coins, so it is bounded by what the stroke physically contains, not by what the client says.
  new.paint_used := greatest(0, least(coalesce(new.paint_used, 0), 100, n * 0.25));
  new.created_at := now();
  return new;
end $$;
drop trigger if exists strokes_guard on strokes;
create trigger strokes_guard before insert on strokes for each row execute function stroke_guard();

-- Canvases: 30 new walls an hour per painter is far past real use.
create or replace function canvas_rate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.author_id is not null and (
    select count(*) from canvases where author_id = new.author_id and created_at > now() - interval '1 hour'
  ) >= 30 then
    raise exception 'slow down' using errcode = '53400';
  end if;
  return new;
end $$;
drop trigger if exists canvases_rate on canvases;
create trigger canvases_rate before insert on canvases for each row execute function canvas_rate();

-- Undo deletes a stroke; the counters it bumped come back down, so paint→undo→paint can't farm them.
create or replace function on_stroke_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update canvases set stroke_count = greatest(0, stroke_count - 1) where id = old.canvas_id;
  if old.author_id is not null then
    update painters set strokes = greatest(0, strokes - 1), paint_used = greatest(0, paint_used - coalesce(old.paint_used, 0))
     where id = old.author_id;
  end if;
  return old;
end $$;
drop trigger if exists strokes_counters_del on strokes;
create trigger strokes_counters_del after delete on strokes for each row execute function on_stroke_delete();

-- Existing rows: clamp what's already there and rebuild the painter counters from it, so any
-- value written directly before this migration is gone.
update strokes s set paint_used = least(s.paint_used, 100, stroke_point_count(s) * 0.25)
 where s.paint_used > least(100, stroke_point_count(s) * 0.25);
update painters p set
  strokes = coalesce(x.n, 0),
  paint_used = coalesce(x.paint, 0)
from (select pp.id, count(s.id) as n, sum(s.paint_used) as paint
        from painters pp left join strokes s on s.author_id = pp.id group by pp.id) x
where x.id = p.id and (p.strokes is distinct from coalesce(x.n, 0) or p.paint_used is distinct from coalesce(x.paint, 0));

-- ------------------------------------------------------------------ 0.5 views --

-- increment_views() was callable by anyone, any number of times. Now: one view per signed-in
-- painter per piece, never your own, and a call without a session just reads the count.
create table if not exists canvas_views (
  canvas_id uuid not null references canvases(id) on delete cascade,
  viewer_id uuid not null references painters(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (canvas_id, viewer_id)
);
alter table canvas_views enable row level security; -- no policies: only increment_views writes it

create or replace function increment_views(cid uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  n integer;
begin
  if me is not null
     and exists (select 1 from painters where id = me)
     and not exists (select 1 from canvases where id = cid and author_id = me) then
    insert into canvas_views (canvas_id, viewer_id) values (cid, me) on conflict do nothing;
    if found then
      update canvases set views = views + 1 where id = cid returning views into n;
      return n;
    end if;
  end if;
  select views into n from canvases where id = cid;
  return n;
end $$;

-- ----------------------------------------------------------------------------
-- 5/8  migration_worldmaps_owned.sql
-- ----------------------------------------------------------------------------

-- World maps become owned by whoever uploaded them. Run after migration_ar.sql. Re-runnable.
--
-- Before: the "worldmaps" bucket let any signed-in user insert or overwrite any object, and
-- set_world_map() let any signed-in user point any canvas at any file. One request could replace
-- a piece's map with garbage and it would stop relocalising for everyone.
--
-- Now: objects live under "<uploader uid>/<canvas id>.<ext>" and only that user can write inside
-- their own folder; set_world_map() only accepts a path in the caller's folder, and only from
-- someone who authored the canvas or has painted on it. Maps uploaded before this stay readable.

drop policy if exists "worldmaps write" on storage.objects;
drop policy if exists "worldmaps update" on storage.objects;
drop policy if exists "worldmaps write own" on storage.objects;
drop policy if exists "worldmaps update own" on storage.objects;
create policy "worldmaps write own" on storage.objects for insert to authenticated
  with check (bucket_id = 'worldmaps' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "worldmaps update own" on storage.objects for update to authenticated
  using (bucket_id = 'worldmaps' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'worldmaps' and (storage.foldername(name))[1] = auth.uid()::text);

create or replace function set_world_map(cid uuid, path text) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null or path is null or split_part(path, '/', 1) <> me::text then
    raise exception 'a world map must be uploaded to your own folder' using errcode = '42501';
  end if;
  if not exists (select 1 from canvases where id = cid and author_id = me)
     and not exists (select 1 from strokes where canvas_id = cid and author_id = me) then
    raise exception 'only someone who painted here can save its map' using errcode = '42501';
  end if;
  update canvases set world_map_path = path, world_map_updated_at = now() where id = cid;
end $$;
revoke all on function set_world_map(uuid, text) from public;
grant execute on function set_world_map(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 6/8  migration_strokes_v2.sql
-- ----------------------------------------------------------------------------

-- Binary stroke points (format 1, see mobile/src/lib/strokeCodec.ts). Run after
-- migration_security.sql. Re-runnable.
--
-- A dab used to be ~90 bytes of jsonb (five full-precision doubles); in points_bin it is ~4 bytes
-- (quantised, delta-coded zigzag varints). New clients write points = null + points_bin; rows
-- written before this keep their jsonb points, and clients read either.
--
-- NOTE: app builds from before this commit read only `points`, so they won't draw strokes that
-- newer builds write. Update every test phone together.

alter table strokes add column if not exists points_bin bytea;
alter table strokes add column if not exists points_v smallint;
alter table strokes alter column points drop not null;

do $$ begin
  alter table strokes add constraint strokes_has_points check (points is not null or points_bin is not null) not valid;
exception when duplicate_object then null; end $$;
-- ~6000 dabs at ≤ 10 bytes each is the most a real stroke can be; stroke_guard also caps the count.
do $$ begin
  alter table strokes add constraint strokes_points_bin_size check (points_bin is null or octet_length(points_bin) <= 65536) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table strokes add constraint strokes_points_json_size check (points is null or octet_length(points::text) <= 600000) not valid;
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- 7/8  migration_geo.sql
-- ----------------------------------------------------------------------------

-- AR strokes can carry the quad's pose on Earth (ARCore Geospatial API, Android for now).
-- Run after migration_ar.sql. Re-runnable.
--
-- geo = { lat, lng, alt, q: [x, y, z, w] (east-up-south), hAcc, yawAcc } — recorded only when the
-- painter's VPS fix was within 5 m / 10 degrees. Any phone with its own good fix can then place the
-- piece in the shared WGS84 frame instead of from GPS + compass. Clients only send the column when
-- a stroke has one, so strokes still upload before this is run.

alter table strokes add column if not exists geo jsonb;
do $$ begin
  alter table strokes add constraint strokes_geo_shape check (
    geo is null or (
      jsonb_typeof(geo -> 'lat') = 'number' and jsonb_typeof(geo -> 'lng') = 'number'
      and jsonb_typeof(geo -> 'alt') = 'number' and jsonb_typeof(geo -> 'q') = 'array'
      and octet_length(geo::text) < 512
    )) not valid;
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- 8/8  seed.sql (optional demo pieces)
-- ----------------------------------------------------------------------------

-- Seeded pieces around E7 (run after schema.sql). Safe to re-run: painters upsert by name.
alter table painters alter column id set default gen_random_uuid();
alter table painters drop constraint if exists painters_id_fkey;
delete from canvases where author_name like 'seed_%';

with a as (insert into painters (name) values ('seed_nova') on conflict (name) do update set name = excluded.name returning id),
c as (insert into canvases (lat, lng, heading, title, author_id, author_name) select 43.47295, -80.53985, 200, 'HTN', a.id, 'seed_nova' from a returning id, author_id)
insert into strokes (canvas_id, author_id, author_name, color, cap, points, paint_used)
select c.id, c.author_id, 'seed_nova', '#ff2d95', 'fat', '[[-14,-0.5,2.6,0.16,0],[-14,-0.15,2.6,0.16,0],[-14,0.19,2.6,0.16,0],[-14,0.54,2.6,0.16,0],[-14,0.88,2.6,0.16,0],[-14,1.23,2.6,0.16,0],[-14,1.58,2.6,0.16,0],[-14,1.92,2.6,0.16,0],[-14,2.27,2.6,0.16,0],[-14,2.62,2.6,0.16,0],[-14,2.96,2.6,0.16,0],[-14,3.31,2.6,0.16,0],[-14,3.65,2.6,0.16,0],[-14,4,2.6,0.16,0],[-14,4.35,2.6,0.16,0],[-14,4.69,2.6,0.16,0],[-14,5.04,2.6,0.16,0],[-14,5.38,2.6,0.16,0],[-14,5.73,2.6,0.16,0],[-14,6.08,2.6,0.16,0],[-14,6.42,2.6,0.16,0],[-14,6.77,2.6,0.16,0],[-14,7.12,2.6,0.16,0],[-14,7.46,2.6,0.16,0],[-14,7.81,2.6,0.16,0],[-14,8.15,2.6,0.16,0],[-14,8.5,2.6,0.16,0],[-7.7,-0.5,2.6,0.16,0],[-7.7,-0.15,2.6,0.16,0],[-7.7,0.19,2.6,0.16,0],[-7.7,0.54,2.6,0.16,0],[-7.7,0.88,2.6,0.16,0],[-7.7,1.23,2.6,0.16,0],[-7.7,1.58,2.6,0.16,0],[-7.7,1.92,2.6,0.16,0],[-7.7,2.27,2.6,0.16,0],[-7.7,2.62,2.6,0.16,0],[-7.7,2.96,2.6,0.16,0],[-7.7,3.31,2.6,0.16,0],[-7.7,3.65,2.6,0.16,0],[-7.7,4,2.6,0.16,0],[-7.7,4.35,2.6,0.16,0],[-7.7,4.69,2.6,0.16,0],[-7.7,5.04,2.6,0.16,0],[-7.7,5.38,2.6,0.16,0],[-7.7,5.73,2.6,0.16,0],[-7.7,6.08,2.6,0.16,0],[-7.7,6.42,2.6,0.16,0],[-7.7,6.77,2.6,0.16,0],[-7.7,7.12,2.6,0.16,0],[-7.7,7.46,2.6,0.16,0],[-7.7,7.81,2.6,0.16,0],[-7.7,8.15,2.6,0.16,0],[-7.7,8.5,2.6,0.16,0],[-14,4,2.6,0.16,0],[-13.65,4,2.6,0.16,0],[-13.3,4,2.6,0.16,0],[-12.95,4,2.6,0.16,0],[-12.6,4,2.6,0.16,0],[-12.25,4,2.6,0.16,0],[-11.9,4,2.6,0.16,0],[-11.55,4,2.6,0.16,0],[-11.2,4,2.6,0.16,0],[-10.85,4,2.6,0.16,0],[-10.5,4,2.6,0.16,0],[-10.15,4,2.6,0.16,0],[-9.8,4,2.6,0.16,0],[-9.45,4,2.6,0.16,0],[-9.1,4,2.6,0.16,0],[-8.75,4,2.6,0.16,0],[-8.4,4,2.6,0.16,0],[-8.05,4,2.6,0.16,0],[-7.7,4,2.6,0.16,0],[-4.55,8.5,2.6,0.16,0],[-4.2,8.5,2.6,0.16,0],[-3.85,8.5,2.6,0.16,0],[-3.5,8.5,2.6,0.16,0],[-3.15,8.5,2.6,0.16,0],[-2.8,8.5,2.6,0.16,0],[-2.45,8.5,2.6,0.16,0],[-2.1,8.5,2.6,0.16,0],[-1.75,8.5,2.6,0.16,0],[-1.4,8.5,2.6,0.16,0],[-1.05,8.5,2.6,0.16,0],[-0.7,8.5,2.6,0.16,0],[-0.35,8.5,2.6,0.16,0],[0,8.5,2.6,0.16,0],[0.35,8.5,2.6,0.16,0],[0.7,8.5,2.6,0.16,0],[1.05,8.5,2.6,0.16,0],[1.4,8.5,2.6,0.16,0],[1.75,8.5,2.6,0.16,0],[-1.4,8.5,2.6,0.16,0],[-1.4,8.15,2.6,0.16,0],[-1.4,7.81,2.6,0.16,0],[-1.4,7.46,2.6,0.16,0],[-1.4,7.12,2.6,0.16,0],[-1.4,6.77,2.6,0.16,0],[-1.4,6.42,2.6,0.16,0],[-1.4,6.08,2.6,0.16,0],[-1.4,5.73,2.6,0.16,0],[-1.4,5.38,2.6,0.16,0],[-1.4,5.04,2.6,0.16,0],[-1.4,4.69,2.6,0.16,0],[-1.4,4.35,2.6,0.16,0],[-1.4,4,2.6,0.16,0],[-1.4,3.65,2.6,0.16,0],[-1.4,3.31,2.6,0.16,0],[-1.4,2.96,2.6,0.16,0],[-1.4,2.62,2.6,0.16,0],[-1.4,2.27,2.6,0.16,0],[-1.4,1.92,2.6,0.16,0],[-1.4,1.58,2.6,0.16,0],[-1.4,1.23,2.6,0.16,0],[-1.4,0.88,2.6,0.16,0],[-1.4,0.54,2.6,0.16,0],[-1.4,0.19,2.6,0.16,0],[-1.4,-0.15,2.6,0.16,0],[-1.4,-0.5,2.6,0.16,0],[4.9,-0.5,2.6,0.16,0],[4.9,-0.15,2.6,0.16,0],[4.9,0.19,2.6,0.16,0],[4.9,0.54,2.6,0.16,0],[4.9,0.88,2.6,0.16,0],[4.9,1.23,2.6,0.16,0],[4.9,1.58,2.6,0.16,0],[4.9,1.92,2.6,0.16,0],[4.9,2.27,2.6,0.16,0],[4.9,2.62,2.6,0.16,0],[4.9,2.96,2.6,0.16,0],[4.9,3.31,2.6,0.16,0],[4.9,3.65,2.6,0.16,0],[4.9,4,2.6,0.16,0],[4.9,4.35,2.6,0.16,0],[4.9,4.69,2.6,0.16,0],[4.9,5.04,2.6,0.16,0],[4.9,5.38,2.6,0.16,0],[4.9,5.73,2.6,0.16,0],[4.9,6.08,2.6,0.16,0],[4.9,6.42,2.6,0.16,0],[4.9,6.77,2.6,0.16,0],[4.9,7.12,2.6,0.16,0],[4.9,7.46,2.6,0.16,0],[4.9,7.81,2.6,0.16,0],[4.9,8.15,2.6,0.16,0],[4.9,8.5,2.6,0.16,0],[4.9,8.5,2.6,0.16,0],[5.1,8.22,2.6,0.16,0],[5.29,7.94,2.6,0.16,0],[5.49,7.66,2.6,0.16,0],[5.69,7.38,2.6,0.16,0],[5.88,7.09,2.6,0.16,0],[6.08,6.81,2.6,0.16,0],[6.28,6.53,2.6,0.16,0],[6.47,6.25,2.6,0.16,0],[6.67,5.97,2.6,0.16,0],[6.87,5.69,2.6,0.16,0],[7.07,5.41,2.6,0.16,0],[7.26,5.13,2.6,0.16,0],[7.46,4.84,2.6,0.16,0],[7.66,4.56,2.6,0.16,0],[7.85,4.28,2.6,0.16,0],[8.05,4,2.6,0.16,0],[8.25,3.72,2.6,0.16,0],[8.44,3.44,2.6,0.16,0],[8.64,3.16,2.6,0.16,0],[8.84,2.88,2.6,0.16,0],[9.03,2.59,2.6,0.16,0],[9.23,2.31,2.6,0.16,0],[9.43,2.03,2.6,0.16,0],[9.63,1.75,2.6,0.16,0],[9.82,1.47,2.6,0.16,0],[10.02,1.19,2.6,0.16,0],[10.22,0.91,2.6,0.16,0],[10.41,0.63,2.6,0.16,0],[10.61,0.34,2.6,0.16,0],[10.81,0.06,2.6,0.16,0],[11,-0.22,2.6,0.16,0],[11.2,-0.5,2.6,0.16,0],[11.2,-0.5,2.6,0.16,0],[11.2,-0.15,2.6,0.16,0],[11.2,0.19,2.6,0.16,0],[11.2,0.54,2.6,0.16,0],[11.2,0.88,2.6,0.16,0],[11.2,1.23,2.6,0.16,0],[11.2,1.58,2.6,0.16,0],[11.2,1.92,2.6,0.16,0],[11.2,2.27,2.6,0.16,0],[11.2,2.62,2.6,0.16,0],[11.2,2.96,2.6,0.16,0],[11.2,3.31,2.6,0.16,0],[11.2,3.65,2.6,0.16,0],[11.2,4,2.6,0.16,0],[11.2,4.35,2.6,0.16,0],[11.2,4.69,2.6,0.16,0],[11.2,5.04,2.6,0.16,0],[11.2,5.38,2.6,0.16,0],[11.2,5.73,2.6,0.16,0],[11.2,6.08,2.6,0.16,0],[11.2,6.42,2.6,0.16,0],[11.2,6.77,2.6,0.16,0],[11.2,7.12,2.6,0.16,0],[11.2,7.46,2.6,0.16,0],[11.2,7.81,2.6,0.16,0],[11.2,8.15,2.6,0.16,0],[11.2,8.5,2.6,0.16,0]]'::jsonb, 34 from c;

with a as (insert into painters (name) values ('seed_kit') on conflict (name) do update set name = excluded.name returning id),
c as (insert into canvases (lat, lng, heading, title, author_id, author_name) select 43.47265, -80.5403, 120, 'smiley', a.id, 'seed_kit' from a returning id, author_id)
insert into strokes (canvas_id, author_id, author_name, color, cap, points, paint_used)
select c.id, c.author_id, 'seed_kit', '#ffe600', 'fat', '[[10,2,2.6,0.16,0],[9.98,2.31,2.6,0.16,0],[9.95,2.63,2.6,0.16,0],[9.93,2.94,2.6,0.16,0],[9.9,3.25,2.6,0.16,0],[9.88,3.56,2.6,0.16,0],[9.88,3.56,2.6,0.16,0],[9.8,3.87,2.6,0.16,0],[9.73,4.17,2.6,0.16,0],[9.66,4.48,2.6,0.16,0],[9.58,4.79,2.6,0.16,0],[9.51,5.09,2.6,0.16,0],[9.51,5.09,2.6,0.16,0],[9.39,5.38,2.6,0.16,0],[9.27,5.67,2.6,0.16,0],[9.15,5.96,2.6,0.16,0],[9.03,6.25,2.6,0.16,0],[8.91,6.54,2.6,0.16,0],[8.91,6.54,2.6,0.16,0],[8.75,6.81,2.6,0.16,0],[8.58,7.08,2.6,0.16,0],[8.42,7.34,2.6,0.16,0],[8.25,7.61,2.6,0.16,0],[8.09,7.88,2.6,0.16,0],[8.09,7.88,2.6,0.16,0],[7.89,8.12,2.6,0.16,0],[7.68,8.36,2.6,0.16,0],[7.48,8.59,2.6,0.16,0],[7.27,8.83,2.6,0.16,0],[7.07,9.07,2.6,0.16,0],[7.07,9.07,2.6,0.16,0],[6.83,9.27,2.6,0.16,0],[6.59,9.48,2.6,0.16,0],[6.36,9.68,2.6,0.16,0],[6.12,9.89,2.6,0.16,0],[5.88,10.09,2.6,0.16,0],[5.88,10.09,2.6,0.16,0],[5.61,10.25,2.6,0.16,0],[5.34,10.42,2.6,0.16,0],[5.08,10.58,2.6,0.16,0],[4.81,10.75,2.6,0.16,0],[4.54,10.91,2.6,0.16,0],[4.54,10.91,2.6,0.16,0],[4.25,11.03,2.6,0.16,0],[3.96,11.15,2.6,0.16,0],[3.67,11.27,2.6,0.16,0],[3.38,11.39,2.6,0.16,0],[3.09,11.51,2.6,0.16,0],[3.09,11.51,2.6,0.16,0],[2.79,11.58,2.6,0.16,0],[2.48,11.66,2.6,0.16,0],[2.17,11.73,2.6,0.16,0],[1.87,11.8,2.6,0.16,0],[1.56,11.88,2.6,0.16,0],[1.56,11.88,2.6,0.16,0],[1.25,11.9,2.6,0.16,0],[0.94,11.93,2.6,0.16,0],[0.63,11.95,2.6,0.16,0],[0.31,11.98,2.6,0.16,0],[0,12,2.6,0.16,0],[0,12,2.6,0.16,0],[-0.31,11.98,2.6,0.16,0],[-0.63,11.95,2.6,0.16,0],[-0.94,11.93,2.6,0.16,0],[-1.25,11.9,2.6,0.16,0],[-1.56,11.88,2.6,0.16,0],[-1.56,11.88,2.6,0.16,0],[-1.87,11.8,2.6,0.16,0],[-2.17,11.73,2.6,0.16,0],[-2.48,11.66,2.6,0.16,0],[-2.79,11.58,2.6,0.16,0],[-3.09,11.51,2.6,0.16,0],[-3.09,11.51,2.6,0.16,0],[-3.38,11.39,2.6,0.16,0],[-3.67,11.27,2.6,0.16,0],[-3.96,11.15,2.6,0.16,0],[-4.25,11.03,2.6,0.16,0],[-4.54,10.91,2.6,0.16,0],[-4.54,10.91,2.6,0.16,0],[-4.81,10.75,2.6,0.16,0],[-5.08,10.58,2.6,0.16,0],[-5.34,10.42,2.6,0.16,0],[-5.61,10.25,2.6,0.16,0],[-5.88,10.09,2.6,0.16,0],[-5.88,10.09,2.6,0.16,0],[-6.12,9.89,2.6,0.16,0],[-6.36,9.68,2.6,0.16,0],[-6.59,9.48,2.6,0.16,0],[-6.83,9.27,2.6,0.16,0],[-7.07,9.07,2.6,0.16,0],[-7.07,9.07,2.6,0.16,0],[-7.27,8.83,2.6,0.16,0],[-7.48,8.59,2.6,0.16,0],[-7.68,8.36,2.6,0.16,0],[-7.89,8.12,2.6,0.16,0],[-8.09,7.88,2.6,0.16,0],[-8.09,7.88,2.6,0.16,0],[-8.25,7.61,2.6,0.16,0],[-8.42,7.34,2.6,0.16,0],[-8.58,7.08,2.6,0.16,0],[-8.75,6.81,2.6,0.16,0],[-8.91,6.54,2.6,0.16,0],[-8.91,6.54,2.6,0.16,0],[-9.03,6.25,2.6,0.16,0],[-9.15,5.96,2.6,0.16,0],[-9.27,5.67,2.6,0.16,0],[-9.39,5.38,2.6,0.16,0],[-9.51,5.09,2.6,0.16,0],[-9.51,5.09,2.6,0.16,0],[-9.58,4.79,2.6,0.16,0],[-9.66,4.48,2.6,0.16,0],[-9.73,4.17,2.6,0.16,0],[-9.8,3.87,2.6,0.16,0],[-9.88,3.56,2.6,0.16,0],[-9.88,3.56,2.6,0.16,0],[-9.9,3.25,2.6,0.16,0],[-9.93,2.94,2.6,0.16,0],[-9.95,2.63,2.6,0.16,0],[-9.98,2.31,2.6,0.16,0],[-10,2,2.6,0.16,0],[-10,2,2.6,0.16,0],[-9.98,1.69,2.6,0.16,0],[-9.95,1.37,2.6,0.16,0],[-9.93,1.06,2.6,0.16,0],[-9.9,0.75,2.6,0.16,0],[-9.88,0.44,2.6,0.16,0],[-9.88,0.44,2.6,0.16,0],[-9.8,0.13,2.6,0.16,0],[-9.73,-0.17,2.6,0.16,0],[-9.66,-0.48,2.6,0.16,0],[-9.58,-0.79,2.6,0.16,0],[-9.51,-1.09,2.6,0.16,0],[-9.51,-1.09,2.6,0.16,0],[-9.39,-1.38,2.6,0.16,0],[-9.27,-1.67,2.6,0.16,0],[-9.15,-1.96,2.6,0.16,0],[-9.03,-2.25,2.6,0.16,0],[-8.91,-2.54,2.6,0.16,0],[-8.91,-2.54,2.6,0.16,0],[-8.75,-2.81,2.6,0.16,0],[-8.58,-3.08,2.6,0.16,0],[-8.42,-3.34,2.6,0.16,0],[-8.25,-3.61,2.6,0.16,0],[-8.09,-3.88,2.6,0.16,0],[-8.09,-3.88,2.6,0.16,0],[-7.89,-4.12,2.6,0.16,0],[-7.68,-4.36,2.6,0.16,0],[-7.48,-4.59,2.6,0.16,0],[-7.27,-4.83,2.6,0.16,0],[-7.07,-5.07,2.6,0.16,0],[-7.07,-5.07,2.6,0.16,0],[-6.83,-5.27,2.6,0.16,0],[-6.59,-5.48,2.6,0.16,0],[-6.36,-5.68,2.6,0.16,0],[-6.12,-5.89,2.6,0.16,0],[-5.88,-6.09,2.6,0.16,0],[-5.88,-6.09,2.6,0.16,0],[-5.61,-6.25,2.6,0.16,0],[-5.34,-6.42,2.6,0.16,0],[-5.08,-6.58,2.6,0.16,0],[-4.81,-6.75,2.6,0.16,0],[-4.54,-6.91,2.6,0.16,0],[-4.54,-6.91,2.6,0.16,0],[-4.25,-7.03,2.6,0.16,0],[-3.96,-7.15,2.6,0.16,0],[-3.67,-7.27,2.6,0.16,0],[-3.38,-7.39,2.6,0.16,0],[-3.09,-7.51,2.6,0.16,0],[-3.09,-7.51,2.6,0.16,0],[-2.79,-7.58,2.6,0.16,0],[-2.48,-7.66,2.6,0.16,0],[-2.17,-7.73,2.6,0.16,0],[-1.87,-7.8,2.6,0.16,0],[-1.56,-7.88,2.6,0.16,0],[-1.56,-7.88,2.6,0.16,0],[-1.25,-7.9,2.6,0.16,0],[-0.94,-7.93,2.6,0.16,0],[-0.63,-7.95,2.6,0.16,0],[-0.31,-7.98,2.6,0.16,0],[0,-8,2.6,0.16,0],[0,-8,2.6,0.16,0],[0.31,-7.98,2.6,0.16,0],[0.63,-7.95,2.6,0.16,0],[0.94,-7.93,2.6,0.16,0],[1.25,-7.9,2.6,0.16,0],[1.56,-7.88,2.6,0.16,0],[1.56,-7.88,2.6,0.16,0],[1.87,-7.8,2.6,0.16,0],[2.17,-7.73,2.6,0.16,0],[2.48,-7.66,2.6,0.16,0],[2.79,-7.58,2.6,0.16,0],[3.09,-7.51,2.6,0.16,0],[3.09,-7.51,2.6,0.16,0],[3.38,-7.39,2.6,0.16,0],[3.67,-7.27,2.6,0.16,0],[3.96,-7.15,2.6,0.16,0],[4.25,-7.03,2.6,0.16,0],[4.54,-6.91,2.6,0.16,0],[4.54,-6.91,2.6,0.16,0],[4.81,-6.75,2.6,0.16,0],[5.08,-6.58,2.6,0.16,0],[5.34,-6.42,2.6,0.16,0],[5.61,-6.25,2.6,0.16,0],[5.88,-6.09,2.6,0.16,0],[5.88,-6.09,2.6,0.16,0],[6.12,-5.89,2.6,0.16,0],[6.36,-5.68,2.6,0.16,0],[6.59,-5.48,2.6,0.16,0],[6.83,-5.27,2.6,0.16,0],[7.07,-5.07,2.6,0.16,0],[7.07,-5.07,2.6,0.16,0],[7.27,-4.83,2.6,0.16,0],[7.48,-4.59,2.6,0.16,0],[7.68,-4.36,2.6,0.16,0],[7.89,-4.12,2.6,0.16,0],[8.09,-3.88,2.6,0.16,0],[8.09,-3.88,2.6,0.16,0],[8.25,-3.61,2.6,0.16,0],[8.42,-3.34,2.6,0.16,0],[8.58,-3.08,2.6,0.16,0],[8.75,-2.81,2.6,0.16,0],[8.91,-2.54,2.6,0.16,0],[8.91,-2.54,2.6,0.16,0],[9.03,-2.25,2.6,0.16,0],[9.15,-1.96,2.6,0.16,0],[9.27,-1.67,2.6,0.16,0],[9.39,-1.38,2.6,0.16,0],[9.51,-1.09,2.6,0.16,0],[9.51,-1.09,2.6,0.16,0],[9.58,-0.79,2.6,0.16,0],[9.66,-0.48,2.6,0.16,0],[9.73,-0.17,2.6,0.16,0],[9.8,0.13,2.6,0.16,0],[9.88,0.44,2.6,0.16,0],[9.88,0.44,2.6,0.16,0],[9.9,0.75,2.6,0.16,0],[9.93,1.06,2.6,0.16,0],[9.95,1.37,2.6,0.16,0],[9.98,1.69,2.6,0.16,0],[10,2,2.6,0.16,0],[-2.3,5,2.6,0.16,0],[-2.38,5.3,2.6,0.16,0],[-2.46,5.6,2.6,0.16,0],[-2.46,5.6,2.6,0.16,0],[-2.68,5.82,2.6,0.16,0],[-2.9,6.04,2.6,0.16,0],[-2.9,6.04,2.6,0.16,0],[-3.2,6.12,2.6,0.16,0],[-3.5,6.2,2.6,0.16,0],[-3.5,6.2,2.6,0.16,0],[-3.8,6.12,2.6,0.16,0],[-4.1,6.04,2.6,0.16,0],[-4.1,6.04,2.6,0.16,0],[-4.32,5.82,2.6,0.16,0],[-4.54,5.6,2.6,0.16,0],[-4.54,5.6,2.6,0.16,0],[-4.62,5.3,2.6,0.16,0],[-4.7,5,2.6,0.16,0],[-4.7,5,2.6,0.16,0],[-4.62,4.7,2.6,0.16,0],[-4.54,4.4,2.6,0.16,0],[-4.54,4.4,2.6,0.16,0],[-4.32,4.18,2.6,0.16,0],[-4.1,3.96,2.6,0.16,0],[-4.1,3.96,2.6,0.16,0],[-3.8,3.88,2.6,0.16,0],[-3.5,3.8,2.6,0.16,0],[-3.5,3.8,2.6,0.16,0],[-3.2,3.88,2.6,0.16,0],[-2.9,3.96,2.6,0.16,0],[-2.9,3.96,2.6,0.16,0],[-2.68,4.18,2.6,0.16,0],[-2.46,4.4,2.6,0.16,0],[-2.46,4.4,2.6,0.16,0],[-2.38,4.7,2.6,0.16,0],[-2.3,5,2.6,0.16,0],[4.7,5,2.6,0.16,0],[4.62,5.3,2.6,0.16,0],[4.54,5.6,2.6,0.16,0],[4.54,5.6,2.6,0.16,0],[4.32,5.82,2.6,0.16,0],[4.1,6.04,2.6,0.16,0],[4.1,6.04,2.6,0.16,0],[3.8,6.12,2.6,0.16,0],[3.5,6.2,2.6,0.16,0],[3.5,6.2,2.6,0.16,0],[3.2,6.12,2.6,0.16,0],[2.9,6.04,2.6,0.16,0],[2.9,6.04,2.6,0.16,0],[2.68,5.82,2.6,0.16,0],[2.46,5.6,2.6,0.16,0],[2.46,5.6,2.6,0.16,0],[2.38,5.3,2.6,0.16,0],[2.3,5,2.6,0.16,0],[2.3,5,2.6,0.16,0],[2.38,4.7,2.6,0.16,0],[2.46,4.4,2.6,0.16,0],[2.46,4.4,2.6,0.16,0],[2.68,4.18,2.6,0.16,0],[2.9,3.96,2.6,0.16,0],[2.9,3.96,2.6,0.16,0],[3.2,3.88,2.6,0.16,0],[3.5,3.8,2.6,0.16,0],[3.5,3.8,2.6,0.16,0],[3.8,3.88,2.6,0.16,0],[4.1,3.96,2.6,0.16,0],[4.1,3.96,2.6,0.16,0],[4.32,4.18,2.6,0.16,0],[4.54,4.4,2.6,0.16,0],[4.54,4.4,2.6,0.16,0],[4.62,4.7,2.6,0.16,0],[4.7,5,2.6,0.16,0],[-5.64,-1.05,2.6,0.16,0],[-5.51,-1.33,2.6,0.16,0],[-5.39,-1.61,2.6,0.16,0],[-5.26,-1.89,2.6,0.16,0],[-5.26,-1.89,2.6,0.16,0],[-5.09,-2.14,2.6,0.16,0],[-4.93,-2.4,2.6,0.16,0],[-4.76,-2.65,2.6,0.16,0],[-4.76,-2.65,2.6,0.16,0],[-4.56,-2.88,2.6,0.16,0],[-4.35,-3.11,2.6,0.16,0],[-4.15,-3.33,2.6,0.16,0],[-4.15,-3.33,2.6,0.16,0],[-3.91,-3.53,2.6,0.16,0],[-3.68,-3.72,2.6,0.16,0],[-3.44,-3.91,2.6,0.16,0],[-3.44,-3.91,2.6,0.16,0],[-3.18,-4.07,2.6,0.16,0],[-2.92,-4.23,2.6,0.16,0],[-2.65,-4.38,2.6,0.16,0],[-2.65,-4.38,2.6,0.16,0],[-2.37,-4.49,2.6,0.16,0],[-2.09,-4.61,2.6,0.16,0],[-1.8,-4.72,2.6,0.16,0],[-1.8,-4.72,2.6,0.16,0],[-1.51,-4.79,2.6,0.16,0],[-1.21,-4.86,2.6,0.16,0],[-0.91,-4.93,2.6,0.16,0],[-0.91,-4.93,2.6,0.16,0],[-0.61,-4.95,2.6,0.16,0],[-0.3,-4.98,2.6,0.16,0],[0,-5,2.6,0.16,0],[0,-5,2.6,0.16,0],[0.3,-4.98,2.6,0.16,0],[0.61,-4.95,2.6,0.16,0],[0.91,-4.93,2.6,0.16,0],[0.91,-4.93,2.6,0.16,0],[1.21,-4.86,2.6,0.16,0],[1.51,-4.79,2.6,0.16,0],[1.8,-4.72,2.6,0.16,0],[1.8,-4.72,2.6,0.16,0],[2.09,-4.61,2.6,0.16,0],[2.37,-4.49,2.6,0.16,0],[2.65,-4.38,2.6,0.16,0],[2.65,-4.38,2.6,0.16,0],[2.92,-4.23,2.6,0.16,0],[3.18,-4.07,2.6,0.16,0],[3.44,-3.91,2.6,0.16,0],[3.44,-3.91,2.6,0.16,0],[3.68,-3.72,2.6,0.16,0],[3.91,-3.53,2.6,0.16,0],[4.15,-3.33,2.6,0.16,0],[4.15,-3.33,2.6,0.16,0],[4.35,-3.11,2.6,0.16,0],[4.56,-2.88,2.6,0.16,0],[4.76,-2.65,2.6,0.16,0],[4.76,-2.65,2.6,0.16,0],[4.93,-2.4,2.6,0.16,0],[5.09,-2.14,2.6,0.16,0],[5.26,-1.89,2.6,0.16,0],[5.26,-1.89,2.6,0.16,0],[5.39,-1.61,2.6,0.16,0],[5.51,-1.33,2.6,0.16,0],[5.64,-1.05,2.6,0.16,0]]'::jsonb, 63 from c;

with a as (insert into painters (name) values ('seed_lux') on conflict (name) do update set name = excluded.name returning id),
c as (insert into canvases (lat, lng, heading, title, author_id, author_name) select 43.4732, -80.5394, 300, 'arrow', a.id, 'seed_lux' from a returning id, author_id)
insert into strokes (canvas_id, author_id, author_name, color, cap, points, paint_used)
select c.id, c.author_id, 'seed_lux', '#19e6ff', 'skinny', '[[-12,-2,1.15,0.16,0],[-11.65,-2,1.15,0.16,0],[-11.3,-2,1.15,0.16,0],[-10.95,-2,1.15,0.16,0],[-10.6,-2,1.15,0.16,0],[-10.25,-2,1.15,0.16,0],[-9.9,-2,1.15,0.16,0],[-9.56,-2,1.15,0.16,0],[-9.21,-2,1.15,0.16,0],[-8.86,-2,1.15,0.16,0],[-8.51,-2,1.15,0.16,0],[-8.16,-2,1.15,0.16,0],[-7.81,-2,1.15,0.16,0],[-7.46,-2,1.15,0.16,0],[-7.11,-2,1.15,0.16,0],[-6.76,-2,1.15,0.16,0],[-6.41,-2,1.15,0.16,0],[-6.06,-2,1.15,0.16,0],[-5.71,-2,1.15,0.16,0],[-5.37,-2,1.15,0.16,0],[-5.02,-2,1.15,0.16,0],[-4.67,-2,1.15,0.16,0],[-4.32,-2,1.15,0.16,0],[-3.97,-2,1.15,0.16,0],[-3.62,-2,1.15,0.16,0],[-3.27,-2,1.15,0.16,0],[-2.92,-2,1.15,0.16,0],[-2.57,-2,1.15,0.16,0],[-2.22,-2,1.15,0.16,0],[-1.87,-2,1.15,0.16,0],[-1.52,-2,1.15,0.16,0],[-1.17,-2,1.15,0.16,0],[-0.83,-2,1.15,0.16,0],[-0.48,-2,1.15,0.16,0],[-0.13,-2,1.15,0.16,0],[0.22,-2,1.15,0.16,0],[0.57,-2,1.15,0.16,0],[0.92,-2,1.15,0.16,0],[1.27,-2,1.15,0.16,0],[1.62,-2,1.15,0.16,0],[1.97,-2,1.15,0.16,0],[2.32,-2,1.15,0.16,0],[2.67,-2,1.15,0.16,0],[3.02,-2,1.15,0.16,0],[3.37,-2,1.15,0.16,0],[3.71,-2,1.15,0.16,0],[4.06,-2,1.15,0.16,0],[4.41,-2,1.15,0.16,0],[4.76,-2,1.15,0.16,0],[5.11,-2,1.15,0.16,0],[5.46,-2,1.15,0.16,0],[5.81,-2,1.15,0.16,0],[6.16,-2,1.15,0.16,0],[6.51,-2,1.15,0.16,0],[6.86,-2,1.15,0.16,0],[7.21,-2,1.15,0.16,0],[7.56,-2,1.15,0.16,0],[7.9,-2,1.15,0.16,0],[8.25,-2,1.15,0.16,0],[8.6,-2,1.15,0.16,0],[8.95,-2,1.15,0.16,0],[9.3,-2,1.15,0.16,0],[9.65,-2,1.15,0.16,0],[10,-2,1.15,0.16,0],[4,4,1.15,0.16,0],[4.24,3.76,1.15,0.16,0],[4.48,3.52,1.15,0.16,0],[4.72,3.28,1.15,0.16,0],[4.96,3.04,1.15,0.16,0],[5.2,2.8,1.15,0.16,0],[5.44,2.56,1.15,0.16,0],[5.68,2.32,1.15,0.16,0],[5.92,2.08,1.15,0.16,0],[6.16,1.84,1.15,0.16,0],[6.4,1.6,1.15,0.16,0],[6.64,1.36,1.15,0.16,0],[6.88,1.12,1.15,0.16,0],[7.12,0.88,1.15,0.16,0],[7.36,0.64,1.15,0.16,0],[7.6,0.4,1.15,0.16,0],[7.84,0.16,1.15,0.16,0],[8.08,-0.08,1.15,0.16,0],[8.32,-0.32,1.15,0.16,0],[8.56,-0.56,1.15,0.16,0],[8.8,-0.8,1.15,0.16,0],[9.04,-1.04,1.15,0.16,0],[9.28,-1.28,1.15,0.16,0],[9.52,-1.52,1.15,0.16,0],[9.76,-1.76,1.15,0.16,0],[10,-2,1.15,0.16,0],[10,-2,1.15,0.16,0],[9.76,-2.24,1.15,0.16,0],[9.52,-2.48,1.15,0.16,0],[9.28,-2.72,1.15,0.16,0],[9.04,-2.96,1.15,0.16,0],[8.8,-3.2,1.15,0.16,0],[8.56,-3.44,1.15,0.16,0],[8.32,-3.68,1.15,0.16,0],[8.08,-3.92,1.15,0.16,0],[7.84,-4.16,1.15,0.16,0],[7.6,-4.4,1.15,0.16,0],[7.36,-4.64,1.15,0.16,0],[7.12,-4.88,1.15,0.16,0],[6.88,-5.12,1.15,0.16,0],[6.64,-5.36,1.15,0.16,0],[6.4,-5.6,1.15,0.16,0],[6.16,-5.84,1.15,0.16,0],[5.92,-6.08,1.15,0.16,0],[5.68,-6.32,1.15,0.16,0],[5.44,-6.56,1.15,0.16,0],[5.2,-6.8,1.15,0.16,0],[4.96,-7.04,1.15,0.16,0],[4.72,-7.28,1.15,0.16,0],[4.48,-7.52,1.15,0.16,0],[4.24,-7.76,1.15,0.16,0],[4,-8,1.15,0.16,0],[-12,6,1.15,0.16,0],[-12,5.65,1.15,0.16,0],[-12,5.3,1.15,0.16,0],[-12,4.96,1.15,0.16,0],[-12,4.61,1.15,0.16,0],[-12,4.26,1.15,0.16,0],[-12,3.91,1.15,0.16,0],[-12,3.57,1.15,0.16,0],[-12,3.22,1.15,0.16,0],[-12,2.87,1.15,0.16,0],[-12,2.52,1.15,0.16,0],[-12,2.17,1.15,0.16,0],[-12,1.83,1.15,0.16,0],[-12,1.48,1.15,0.16,0],[-12,1.13,1.15,0.16,0],[-12,0.78,1.15,0.16,0],[-12,0.43,1.15,0.16,0],[-12,0.09,1.15,0.16,0],[-12,-0.26,1.15,0.16,0],[-12,-0.61,1.15,0.16,0],[-12,-0.96,1.15,0.16,0],[-12,-1.3,1.15,0.16,0],[-12,-1.65,1.15,0.16,0],[-12,-2,1.15,0.16,0],[-12,-2.35,1.15,0.16,0],[-12,-2.7,1.15,0.16,0],[-12,-3.04,1.15,0.16,0],[-12,-3.39,1.15,0.16,0],[-12,-3.74,1.15,0.16,0],[-12,-4.09,1.15,0.16,0],[-12,-4.43,1.15,0.16,0],[-12,-4.78,1.15,0.16,0],[-12,-5.13,1.15,0.16,0],[-12,-5.48,1.15,0.16,0],[-12,-5.83,1.15,0.16,0],[-12,-6.17,1.15,0.16,0],[-12,-6.52,1.15,0.16,0],[-12,-6.87,1.15,0.16,0],[-12,-7.22,1.15,0.16,0],[-12,-7.57,1.15,0.16,0],[-12,-7.91,1.15,0.16,0],[-12,-8.26,1.15,0.16,0],[-12,-8.61,1.15,0.16,0],[-12,-8.96,1.15,0.16,0],[-12,-9.3,1.15,0.16,0],[-12,-9.65,1.15,0.16,0],[-12,-10,1.15,0.16,0]]'::jsonb, 27 from c;

