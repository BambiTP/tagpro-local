// Maps with no valid spawns (a team with no spawn points and no flag, e.g. Gumbo NFC, 98100) give an
// error wherever they're loaded: group launch, P2P host launch, map upload, admin panel.
//   node tools/map-spawn-test.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');

const root = path.join(__dirname, '..');
const HUB = 'http://127.0.0.1:3110', HOST = 'http://127.0.0.1:3111';
const procs = [];
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failures++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (fn, ms = 20000) => new Promise((ok, fail) => {
  const t0 = Date.now();
  (function poll() { const v = fn(); if (v) return ok(v); if (Date.now() - t0 > ms) return fail(new Error('timed out')); setTimeout(poll, 100); })();
});
const run = (args, env) => { const p = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore' }); procs.push(p); return p; };

(async () => {
  // ---- the check itself ----
  const games = require('../server/games');
  check(/Gumbo NFC.*no valid spawns/.test(games.mapProblem('98100') || ''), 'Gumbo NFC: ' + games.mapProblem('98100'));
  const rotation = JSON.parse(fs.readFileSync(path.join(root, 'maps/rotation.json'), 'utf8')).map(String);
  const bad = rotation.filter((k) => games.mapProblem(k));
  check(!bad.length, `every rotation map is playable (${rotation.length})` + (bad.length ? ': ' + bad.join(', ') : ''));
  check(games.mapProblem('eggball') === null, 'the eggball map is fine (eggball spawns its own way)');

  // ---- admin panel: refuses to save it, says why (local admin state restored afterwards) ----
  const admin = require('../server/admin');
  const file = path.join(root, 'data/public-settings.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const r = await admin.update({ map: '98100', rotation: '98100, 93653', gameSize: '8' }, games.fetchFortunateMap, games.mapProblem);
  check(r.invalid.length === 1 && /no valid spawns/.test(r.invalid[0]) && admin.mapChoice() === 'random' && String(admin.rotationPool()) === '93653',
    'admin panel: not saved as the map or in the rotation, with the reason');
  if (before) fs.writeFileSync(file, before); else fs.unlinkSync(file);

  // ---- group launch on this server, upload, and a P2P host ----
  run(['server/index.js'], { PORT: '3110', HOST: '127.0.0.1', P2P_ALLOW_HTTP: '1' });
  let cookie = '';
  const get = async (p, o = {}) => { const res = await fetch(HUB + p, { redirect: 'manual', ...o, headers: { cookie, ...(o.headers || {}) } }); for (const c of res.headers.getSetCookie()) cookie = c.split(';')[0]; return res; };
  for (let i = 0; ; i++) { try { await get('/'); break; } catch (e) { if (i > 100) throw e; await wait(200); } }
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const gid = (await get('/groups/create', { method: 'POST', headers: form, body: 'name=Spawns&private=on' })).headers.get('location').split('/').pop();
  const g = io(HUB + '/groups/' + gid, { transports: ['websocket'], extraHeaders: { cookie }, forceNew: true });
  const chat = [];
  let played = false, status = null;
  g.on('chat', (c) => chat.push(c.message));
  g.on('play', () => { played = true; });
  g.on('p2p', (s) => { status = s; });
  await new Promise((ok) => g.on('loaded', ok));

  g.emit('setting', { name: 'map', value: 'fm_id/98100' });
  await wait(200);
  g.emit('groupPlay');
  await until(() => chat.some((m) => /no valid spawns/.test(m)));
  check(!played, 'group launch: error in chat, no game: ' + chat.find((m) => /no valid spawns/.test(m)));

  const fd = new FormData();
  fd.append('layout', new Blob([fs.readFileSync(path.join(root, 'maps/98100.png'))]), 'map.png');
  fd.append('logic', new Blob([fs.readFileSync(path.join(root, 'maps/98100.json'))]), 'map.json');
  const up = await (await get('/groups/testmap', { method: 'POST', body: fd })).json();
  check(!up.success && /no valid spawns/.test(up.error), 'upload: refused with the reason: ' + up.error);
  const leftovers = fs.readdirSync(path.join(root, 'maps')).filter((f) => f.startsWith('upload-' + gid));
  check(!leftovers.length, 'upload: the refused files are not kept');

  g.emit('setting', { name: 'server', value: 'p2p' });
  await until(() => status && status.on && status.code);
  run(['server/host.js', status.code, '--url', HOST, '--port', '3111', '--hub', HUB]);
  await until(() => status.connected, 30000);
  chat.length = 0;
  g.emit('groupPlay');
  await until(() => chat.some((m) => /no valid spawns/.test(m)));
  check(!played, 'P2P host launch: error in chat, no game: ' + chat.find((m) => /no valid spawns/.test(m)));

  g.disconnect();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  for (const p of procs) p.kill();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); for (const p of procs) p.kill(); process.exit(1); });
