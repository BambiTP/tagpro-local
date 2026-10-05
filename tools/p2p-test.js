// Peer-to-peer groups end to end, all on this machine: a main site on :3100, a host (server/host.js
// with --url, so no tunnel) on :3101. Create P2P group -> host connects -> launch -> the player is
// sent to the host and plays there -> the leader ends the game.
//   node tools/p2p-test.js            (TUNNEL=1: the host opens a real Cloudflare tunnel instead)
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const HUB = 'http://127.0.0.1:3100', HOST = 'http://127.0.0.1:3101';
const root = path.join(__dirname, '..');
const procs = [];
const run = (args, env) => {
  const p = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (b) => process.stdout.write('  [' + args[0] + '] ' + b));
  p.stderr.on('data', (b) => process.stdout.write('  [' + args[0] + ' err] ' + b));
  procs.push(p);
  return p;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (fn, ms = 20000) => new Promise((ok, fail) => {
  const t0 = Date.now();
  (function poll() { const v = fn(); if (v) return ok(v); if (Date.now() - t0 > ms) return fail(new Error('timed out')); setTimeout(poll, 100); })();
});
function jar(base) {
  let cookie = '';
  const get = async (p, opt = {}) => {
    const r = await fetch(p.startsWith('http') ? p : base + p, { redirect: 'manual', ...opt, headers: { cookie, ...(opt.headers || {}) } });
    for (const c of r.headers.getSetCookie?.() || []) cookie = c.split(';')[0];
    return r;
  };
  return { get, sock: (nsp) => io(base + nsp, { transports: ['websocket'], extraHeaders: { cookie }, reconnection: false }) };
}
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failures++; };

(async () => {
  run(['server/index.js'], { PORT: '3100', HOST: '127.0.0.1' });
  const hub = jar(HUB);
  for (let i = 0; ; i++) { try { await hub.get('/'); break; } catch (e) { if (i > 100) throw e; await wait(200); } }
  await hub.get('/local/name', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=P2PTester' });
  const list = await (await hub.get('/groups')).text();
  check(list.includes('Create Peer to Peer Group') && list.includes('formaction="/groups/create-p2p"'), '/groups has the Create Peer to Peer Group button');

  const r = await hub.get('/groups/create-p2p', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=P2P+Test&private=on' });
  const gid = r.headers.get('location').split('/').pop();
  const page = await (await hub.get('/groups/' + gid)).text();
  check(page.includes('id="p2p-panel"'), 'group page has the Peer to Peer box');

  const g = hub.sock('/groups/' + gid);
  let status = null, servers = null, settings = {}, game = null;
  const chat = [];
  g.on('p2p', (s) => { status = s; });
  g.on('servers', (s) => { servers = s; });
  g.on('setting', (s) => { settings[s.name] = s.value; });
  g.on('game', (d) => { game = d; });
  g.on('chat', (c) => chat.push(c.message));
  await new Promise((ok) => g.on('loaded', ok));
  await until(() => status);
  check(servers && servers.map((s) => s.name).join(' | ') === 'Chicago, IL | Peer to Peer (a player hosts)', 'two servers offered: ' + (servers && servers.map((s) => s.name).join(', ')));
  check(settings.server === 'p2p' && settings.serverSelect === true, 'new group is set to the Peer to Peer server');
  check(status.on && !status.connected && /^[\w-]{12}$/.test(status.code || ''), 'leader sees a host code; nobody hosting yet');

  g.emit('groupPlay');
  await until(() => chat.some((m) => /Nobody is hosting/.test(m)));
  check(true, 'launching with no host explains how to host');

  run(['server/host.js', status.code, ...(process.env.TUNNEL ? [] : ['--url', HOST]), '--port', '3101', '--hub', HUB, '--name', 'Tester']);
  await until(() => status.connected, 90000);
  const HOST_URL = status.url;
  check(status.hostName === 'Tester' && (process.env.TUNNEL ? /trycloudflare\.com$/.test(HOST_URL) : HOST_URL === HOST), 'host connected and shown on the group page');

  const hostHome = await fetch(HOST_URL + '/', { redirect: 'manual' });
  check(hostHome.status === 302 && hostHome.headers.get('location') === HUB + '/', 'host sends its home page back to the main site');

  g.emit('setting', { name: 'time', value: '1' });
  await wait(200);
  g.emit('groupPlay');
  await new Promise((ok) => g.on('play', ok));
  check(game && game.gameServer === 'p2p' && /^[a-z]{8}$/.test(game.gameId), 'group shows a game running on the P2P server');

  const j = hub.sock('/games/find');
  j.on('ready', () => j.emit('JoinerSelections', { regions: [], gameModes: ['classic'] }));
  const found = await new Promise((ok) => j.on('FoundWorld', ok));
  check(found.url.startsWith(HOST_URL + '/p2p/join?t='), 'joiner sends the player to the host: ' + found.url.slice(0, 50) + '...');

  const player = jar(HOST_URL);
  const join = await player.get(found.url);
  check(join.status === 302 && join.headers.get('location') === '/game', 'ticket accepted by the host');
  const gamePage = await (await player.get('/game')).text();
  const sockPath = (gamePage.match(/gameSocket = location.origin \+ "([^"]+)"/) || [])[1];
  check(sockPath === '/game/' + game.gameId, 'host serves the game page for that game');
  const gs = player.sock(sockPath);
  let me = null, names = {};
  gs.on('id', (id) => { me = id; });
  gs.on('p', (d) => { for (const u of d.u || d) if (u.name) names[u.id] = u.name; });
  await until(() => me && names[me]);
  check(names[me] === 'P2PTester', 'player is in the host\'s game under their main-site name (' + names[me] + ')');

  const bad = await fetch(HOST_URL + '/p2p/join?t=nope', { redirect: 'manual' });
  check(bad.headers.get('location') === HUB + '/groups', 'a bad ticket goes back to the main site');

  g.emit('endGame');
  await until(() => game && game.gameId === null);
  check(true, 'leader ended the game; the group no longer shows it running');

  gs.disconnect(); j.disconnect(); g.disconnect();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  for (const p of procs) p.kill();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); for (const p of procs) p.kill(); process.exit(1); });
