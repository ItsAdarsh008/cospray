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
