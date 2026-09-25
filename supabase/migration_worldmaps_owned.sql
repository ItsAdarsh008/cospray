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
