// Rebuilds supabase/setup_all.sql from the three SQL files, so the backend can be set up with a
// single paste into the Supabase SQL editor. Run after editing any of them:
//   node scripts/gen_setup_sql.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sql = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase');
const files = [
  ['schema.sql', '1/3  schema.sql'],
  ['migration_ar.sql', '2/3  migration_ar.sql'],
  ['seed.sql', '3/3  seed.sql (optional demo pieces)'],
];

const rule = '-- ' + '-'.repeat(76);
const header = `-- ${'='.repeat(76)}
-- Fresco — one-paste backend setup. Supabase SQL Editor -> New query -> paste
-- this whole file -> Run. Safe to re-run.
--
-- Generated from, and kept identical to, the three files it concatenates:
--   1. schema.sql       tables, triggers, RLS, RPCs, realtime
--   2. migration_ar.sql the AR half: anchor_id / transform / viewer, the
--                       worldmaps bucket, set_world_map, the undo delete policy
--   3. seed.sql         optional demo pieces around E7
-- Edit those files, not this one: scripts/gen_setup_sql.mjs rebuilds it.
-- ${'='.repeat(76)}

`;

const body = files
  .map(([name, title]) => `${rule}\n-- ${title}\n${rule}\n\n${readFileSync(join(sql, name), 'utf8').trimEnd()}\n\n`)
  .join('');

writeFileSync(join(sql, 'setup_all.sql'), header + body);
console.log('wrote supabase/setup_all.sql');
