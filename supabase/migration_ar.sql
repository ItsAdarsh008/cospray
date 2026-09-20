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
