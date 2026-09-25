// Rebuilds supabase/setup_all.sql from the SQL files listed below, so the backend can be set up with a
// single paste into the Supabase SQL editor. Run after editing any of them:
//   node scripts/gen_setup_sql.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sql = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase');
// Order matters: each migration assumes the ones above it have run.
const files = [
  ['schema.sql', 'schema.sql'],
  ['migration_ar.sql', 'migration_ar.sql'],
  ['migration_upvotes.sql', 'migration_upvotes.sql'],
  ['migration_security.sql', 'migration_security.sql'],
  ['migration_worldmaps_owned.sql', 'migration_worldmaps_owned.sql'],
  ['migration_strokes_v2.sql', 'migration_strokes_v2.sql'],
  ['seed.sql', 'seed.sql (optional demo pieces)'],
].map(([name, title], i, all) => [name, `${i + 1}/${all.length}  ${title}`]);

const rule = '-- ' + '-'.repeat(76);
const header = `-- ${'='.repeat(76)}
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
--   seed.sql               optional demo pieces around E7
-- Edit those files, not this one: scripts/gen_setup_sql.mjs rebuilds it.
-- ${'='.repeat(76)}

`;

const body = files
  .map(([name, title]) => `${rule}\n-- ${title}\n${rule}\n\n${readFileSync(join(sql, name), 'utf8').trimEnd()}\n\n`)
  .join('');

writeFileSync(join(sql, 'setup_all.sql'), header + body);
console.log('wrote supabase/setup_all.sql');
