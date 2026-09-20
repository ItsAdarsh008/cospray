// Points every client at a Supabase project and checks the backend is actually set up.
//
//   node scripts/use_supabase.mjs <project-url> <publishable-key>   point + check
//   node scripts/use_supabase.mjs --check                           check what .env already points at
//   node scripts/use_supabase.mjs --check --anon                    also test anonymous sign-in
//                                                                   (creates one throwaway auth user)
//
// Writes .env (the app), web-app/.env + web-app/.env.production (the site) and eas.json's development env
// (cloud builds), which is every place the keys live.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const testAnon = args.includes('--anon');
const positional = args.filter((a) => !a.startsWith('--'));

/** Replaces KEY=... in a dotenv file, keeping every other line, and creates the file if missing. */
function setEnv(file, values) {
  const path = join(root, file);
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(values)) {
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeFileSync(path, lines.filter((l, i) => l !== '' || i < lines.length - 1).join('\n').trimEnd() + '\n');
  console.log(`  wrote ${file}`);
}

function readEnv(file) {
  const path = join(root, file);
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
}

async function check(url, key) {
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const results = [];
  const add = (ok, label, detail = '') => results.push({ ok, label, detail });

  const get = async (path) => {
    try {
      const res = await fetch(`${url}${path}`, { headers });
      return { status: res.status, body: await res.text() };
    } catch (e) {
      return { status: 0, body: String(e) };
    }
  };

  const base = await get('/rest/v1/strokes?select=id&limit=1');
  add(base.status === 200, 'schema.sql ran (strokes table reachable)', base.status === 200 ? '' : base.body.slice(0, 120));

  const ar = await get('/rest/v1/strokes?select=anchor_id,transform,viewer&limit=1');
  add(ar.status === 200, 'migration_ar.sql ran (anchor_id, transform, viewer)', ar.status === 200 ? '' : 'column missing — AR strokes will be refused');

  const map = await get('/rest/v1/canvases?select=world_map_path,world_map_updated_at&limit=1');
  add(map.status === 200, 'canvases carry a world map pointer');

  const rpc = await fetch(`${url}/rest/v1/rpc/nearby_canvases`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ qlat: 43.47, qlng: -80.54, radius_m: 100 }),
  }).then((r) => r.status).catch(() => 0);
  add(rpc === 200, 'nearby_canvases RPC exists');

  // A public bucket answers "Object not found" for a missing key; a missing bucket says so instead.
  const bucket = await get('/storage/v1/object/public/worldmaps/__probe__');
  add(!/bucket not found/i.test(bucket.body), 'worldmaps storage bucket exists', bucket.body.slice(0, 80));

  if (testAnon) {
    const res = await fetch(`${url}/auth/v1/signup`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await res.text();
    add(res.status === 200, 'anonymous sign-in enabled', res.status === 200 ? 'created one throwaway user' : body.slice(0, 120));
  }

  console.log('');
  for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
  const bad = results.filter((r) => !r.ok);
  if (!bad.length) {
    console.log('\nBackend looks right.' + (testAnon ? '' : ' (add --anon to test anonymous sign-in too)'));
    return 0;
  }
  console.log(`\n${bad.length} check(s) failed — paste supabase/setup_all.sql into the SQL editor and re-run this.`);
  if (testAnon === false) console.log('Anonymous sign-in is a dashboard toggle: Authentication -> Providers.');
  return 1;
}

let url;
let key;
if (checkOnly) {
  const env = readEnv('.env');
  url = env.EXPO_PUBLIC_SUPABASE_URL;
  key = env.EXPO_PUBLIC_SUPABASE_KEY;
  if (!url || !key) {
    console.error('.env has no EXPO_PUBLIC_SUPABASE_URL / _KEY yet.');
    process.exit(1);
  }
  console.log(`Checking ${url}`);
} else {
  [url, key] = positional;
  if (!url || !key) {
    console.error('usage: node scripts/use_supabase.mjs <project-url> <publishable-key>');
    console.error('       node scripts/use_supabase.mjs --check [--anon]');
    process.exit(1);
  }
  url = url.replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) console.warn(`  note: ${url} does not look like a project URL`);
  if (/^eyJ.*service_role/.test(key) || key.includes('service_role')) {
    console.error('That looks like the service_role key. Use the anon / publishable key: it ships in the app bundle.');
    process.exit(1);
  }
  console.log(`Pointing the app at ${url}`);
  setEnv('.env', { EXPO_PUBLIC_SUPABASE_URL: url, EXPO_PUBLIC_SUPABASE_KEY: key });
  setEnv('web-app/.env', { VITE_SUPABASE_URL: url, VITE_SUPABASE_KEY: key });
  setEnv('web-app/.env.production', { VITE_SUPABASE_URL: url, VITE_SUPABASE_KEY: key });

  // Patch the values where they sit: re-serialising the JSON would reflow the whole file.
  const easPath = join(root, 'eas.json');
  const before = readFileSync(easPath, 'utf8');
  let eas = before;
  for (const [name, value] of [['EXPO_PUBLIC_SUPABASE_URL', url], ['EXPO_PUBLIC_SUPABASE_KEY', key]]) {
    eas = eas.replace(new RegExp(`("${name}"\\s*:\\s*)"[^"]*"`, 'g'), `$1${JSON.stringify(value)}`);
  }
  if (eas !== before) {
    writeFileSync(easPath, eas);
    console.log('  wrote eas.json (build profiles)');
  } else {
    console.log('  eas.json: no EXPO_PUBLIC_SUPABASE_* entries found — add them by hand if you build with EAS');
  }
  console.log('\nRestart Metro with -c so the new values get inlined: npx expo start --dev-client -c');
}

process.exit(await check(url, key));
