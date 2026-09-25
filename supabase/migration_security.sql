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
