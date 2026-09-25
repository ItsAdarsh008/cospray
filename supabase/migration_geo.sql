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
