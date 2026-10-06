// local.js - single-player TagPro: no groups, accounts, Play Now queue or peer to peer. The server
// only listens on this PC (127.0.0.1), so nobody else can connect. You pick a map and mode, play
// alone or against bots that run inside this process, and watch your replays.
//   npm run local            (PORT=3000 by default)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { GameRoom } = require('../engine/game');
const { MAPS_DIR, mapKeys, checkPngSize, readMap, MapError, checkSpawns, rotationKeys } = require('./maps');
const { BotBrain } = require('./botBrain');
const pages = require('./pages');
const gamepage = require('./gamepage');
const replays = require('./replays');
const { parseCookies } = require('./sessions');

const PORT = Number(process.env.PORT || 3000);
const HOST = '127.0.0.1'; // this PC only: there is nothing here for anyone else
const PUBLIC = path.join(__dirname, '..', 'public');
const music = require(path.join(PUBLIC, 'music.json'));
const DEFAULTS = Object.fromEntries(require('./groupDefaults.json').settings.map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));

const app = express();
const server = http.createServer(app);
// a web page from another site could otherwise drive this server through the browser
function fromOtherSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return true;
  const o = req.headers.origin;
  if (!o) return false;
  try { return new URL(o).host !== req.headers.host; } catch (e) { return true; }
}
const io = new Server(server, { transports: ['websocket', 'polling'], allowRequest: (req, ok) => ok(null, !fromOtherSite(req)) });

app.use(require('compression')());
app.use(express.urlencoded({ extended: true, limit: '50kb' }));
app.use((req, res, next) => (req.method !== 'GET' && req.method !== 'HEAD' && fromOtherSite(req) ? res.status(403).send('Requests from other sites are not allowed.') : next()));

const html = (res, s) => res.type('html').send(s);
// the header's server stats on the real pages: just you
pages.setStatsProvider(() => {
  const live = room && !room.closed ? 1 : 0;
  return { STATS_PLAYERS: live ? Object.keys(room.players).length : 0, STATS_GAMES: live, STATS_ONLINE: 1 };
});

// ---- the one local player, and the choices last used on the launcher ----
const me = { publicId: 'local', name: 'Some Ball', auth: null, pendingGame: null };
const last = { map: 'random', mode: 'classic', team: 1, allies: 0, enemies: 0, time: 6, caps: 0, mapTestingMode: false };
let room = null; // the game being played (one at a time)

// ---- maps ----
function mapList() {
  const out = [];
  for (const key of mapKeys()) {
    if (key === 'eggball') continue; // a mode, not a map to pick
    let name = key;
    try { name = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, key + '.json'), 'utf8')).info.name || key; } catch (e) { /* key */ }
    out.push({ key, name: String(name) + (key.startsWith('upload-') ? ' (uploaded)' : '') });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function launcher(error) {
  const opt = (value, label, sel) => `<option value="${pages.esc(value)}"${sel ? ' selected' : ''}>${pages.esc(label)}</option>`;
  const maps = [opt('random', 'Random (from the rotation)', last.map === 'random')].concat(mapList().map((m) => opt(m.key, m.name, m.key === last.map))).join('');
  const modes = [['classic', 'Capture the Flag'], ['gravity', 'Gravity'], ['eggball', 'Eggball']].map(([v, l]) => opt(v, l, v === last.mode)).join('');
  const count = (n, sel) => Array.from({ length: n + 1 }, (_, i) => opt(i, String(i), i === sel)).join('');
  return pages.render('local.html', {
    NAME: pages.esc(me.name === 'Some Ball' ? '' : me.name), MAP_OPTIONS: maps, MODE_OPTIONS: modes,
    RED: last.team === 1 ? 'checked' : '', BLUE: last.team === 2 ? 'checked' : '',
    ALLY_OPTIONS: count(3, last.allies), ENEMY_OPTIONS: count(4, last.enemies),
    TIME: String(last.time), CAPS: String(last.caps), MAPTEST: last.mapTestingMode ? 'checked' : '',
    ERROR: error ? `<div class="alert alert-danger">${pages.esc(error)}</div>` : '',
    PLAYING: room && !room.closed && !room.ended ? '<a class="btn btn-default" href="/game">Back to your game</a>' : '',
  });
}

// ---- games ----
const gameId = () => Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz'[crypto.randomInt(26)]).join('');
const int = (v, lo, hi, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };

// a bot plays inside this process: it's a game client whose events go straight to its brain
function addBot(r, i, team) {
  let timer = null;
  const client = {
    bot: true,
    emit: (ev, d) => brain.receive(ev, d),
    disconnect: () => clearInterval(timer),
  };
  const brain = new BotBrain(i, (ev, d) => client.onEvent && client.onEvent(ev, d));
  r.addClient(client, { publicId: 'bot' + i, name: 'Bot ' + (i + 1), auth: null }, { team });
  timer = setInterval(() => {
    if (r.closed) return clearInterval(timer);
    try { brain.think(); } catch (e) { console.error('bot', i + 1, e); clearInterval(timer); }
  }, 50);
}

function startGame(choice) {
  if (room && !room.closed) room.close();
  room = null;
  const keys = mapKeys();
  const mapKey = choice.mode === 'eggball' ? 'eggball'
    : keys.includes(choice.map) ? choice.map : (() => { const l = rotationKeys(); return l[Math.floor(Math.random() * l.length)]; })();
  const map = readMap(mapKey);
  const settings = Object.assign({}, DEFAULTS, {
    isPrivate: true, map: mapKey, mode: choice.mode, time: choice.time, caps: choice.caps,
    mercyRule: 0, mapTestingMode: choice.mapTestingMode,
  });
  const id = gameId();
  const r = new GameRoom({
    id, uuid: crypto.randomUUID(), map, mapName: map.info.name, settings, isPrivate: true,
    onEnd: (rm) => setTimeout(() => rm.recorder && rm.recorder.finish(), 3000), // replay saved shortly after the end
    onEmpty: () => {},
  });
  checkSpawns(r);
  r.recorder = new replays.Recorder(r);
  r.addRecorder(r.recorder);
  r.start();
  const enemy = choice.team === 1 ? 2 : 1;
  let n = 0;
  for (let i = 0; i < choice.allies; i++) addBot(r, n++, choice.team);
  for (let i = 0; i < choice.enemies; i++) addBot(r, n++, enemy);
  me.pendingGame = { id, team: choice.team };
  room = r;
  console.log(`game on ${map.info.name}: you + ${choice.allies} ${choice.allies === 1 ? 'teammate' : 'teammates'}, ${choice.enemies} ${choice.enemies === 1 ? 'opponent' : 'opponents'}`);
}

app.get('/', (req, res) => html(res, launcher()));
app.post('/play', (req, res) => {
  const b = req.body;
  const name = String(b.name || '').trim().slice(0, 12);
  me.name = name || 'Some Ball';
  Object.assign(last, {
    map: String(b.map || 'random').slice(0, 100), mode: ['classic', 'gravity', 'eggball'].includes(b.mode) ? b.mode : 'classic',
    team: b.team === '2' ? 2 : 1, allies: int(b.allies, 0, 3, 0), enemies: int(b.enemies, 0, 4, 0),
    time: int(b.time, 1, 60, 6), caps: int(b.caps, 0, 100, 0), mapTestingMode: b.mapTestingMode === 'on',
  });
  try { startGame(last); } catch (e) {
    if (!(e instanceof MapError)) console.error(e);
    return html(res, launcher(e instanceof MapError ? e.message + ' Pick another map.' : "That map couldn't be loaded. Pick another map."));
  }
  res.redirect('/game');
});

// your own map (layout png + logic json), like the group page's map upload
const upload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 2, fields: 10, parts: 12 } });
app.post('/upload', upload.fields([{ name: 'layout', maxCount: 1 }, { name: 'logic', maxCount: 1 }]), (req, res) => {
  const layout = req.files && req.files.layout && req.files.layout[0], logic = req.files && req.files.logic && req.files.logic[0];
  if (!layout || !logic) return html(res, launcher('Choose both the layout (.png) and logic (.json) files.'));
  const key = 'upload-local-' + Date.now();
  const files = ['png', 'json'].map((ext) => path.join(MAPS_DIR, key + '.' + ext));
  try {
    JSON.parse(logic.buffer.toString('utf8'));
    checkPngSize(layout.buffer); // before decoding: a small file can decode to a huge image
    fs.writeFileSync(files[1], logic.buffer);
    fs.writeFileSync(files[0], layout.buffer);
    const map = readMap(key);
    checkSpawns(new GameRoom({ id: 'check', uuid: 'check', map, mapName: map.info.name, settings: {}, isPrivate: true }));
  } catch (e) {
    for (const f of files) try { fs.unlinkSync(f); } catch (x) { /* not written */ }
    return html(res, launcher(e instanceof MapError ? e.message : 'Those map files could not be read.'));
  }
  last.map = key;
  res.redirect('/');
});

app.get('/game', (req, res, next) => {
  // /game?replay=<key>: the real game page in replay mode
  const pack = gamepage.chosenPack(parseCookies(req.headers.cookie));
  if (req.query.replay) return html(res, gamepage.withTextures(pack, pages.render('replay.html', { REPLAY_KEY: pages.esc(String(req.query.replay).slice(0, 80)) })));
  if (!room || room.closed || room.ended) return res.redirect('/');
  html(res, gamepage.forRoom(room, gamepage.withTextures(pack, pages.render('game.html', {
    GAME_SOCKET: '/game/' + room.id, GAME_SERVER: 'local', GAME_ID: room.id, GAME_SOCKET_LABEL: 'This PC', GROUP_ID: 'null',
  }))));
});
// after a game the client goes to the joiner: back to the launcher instead
app.get(['/games/find', '/games/find/'], (req, res) => res.redirect('/'));

// a human connection to the game (there are no others: the bots aren't sockets)
const UNREGISTERED = /^Hi! You're currently playing unregistered/;
io.of(/^\/game\/[a-z]{8}$/).on('connection', (socket) => {
  const r = room && room.id === socket.nsp.name.slice(6) ? room : null;
  if (!r || r.ended) { socket.emit('disconnectReason', 'ended'); return socket.disconnect(); }
  // one ball for you; a second tab watches
  const playing = [...r.clients].some((c) => c.local && !c.spectator);
  const client = {
    local: true,
    emit: (ev, d) => { if (!(ev === 'chat' && d && UNREGISTERED.test(d.message))) socket.emit(ev, d); }, // there's no log in here
    disconnect: () => socket.disconnect(true),
  };
  r.addClient(client, me, { team: me.pendingGame && me.pendingGame.id === r.id ? me.pendingGame.team : null, spectate: playing });
  socket.onAny((ev, d) => client.onEvent && client.onEvent(ev, d));
  socket.on('disconnect', () => {
    r.removeClient(client);
    // you left (closed the tab, went back): the bots stop too, unless you come back (a reload)
    setTimeout(() => { if (!r.closed && ![...r.clients].some((c) => c.local)) r.close(); }, 10000);
  });
});

// ---- replays (every game is recorded) ----
app.get('/replays', (req, res) => html(res, pages.render('replays.html', { USER_ID: '' })));
app.get('/replays/data', (req, res) => res.json(replays.list(req.query, null)));
app.get('/replays/gameFile', (req, res) => {
  const id = req.query.key ? replays.keyToGameId(req.query.key) : String(req.query.gameId || '');
  const f = replays.file(id);
  if (!f) { res.set('X-Replay-Error', 'Replay not found'); return res.status(404).send('Replay not found'); }
  res.set('X-Replay-Filename', f.name);
  if (!req.query.key) res.attachment(f.name.replace(/[^\w .-]/g, '_') + '.ndjson');
  res.type('text/plain').send(replays.ensureId(fs.readFileSync(f.path, 'utf8')));
});

// ---- texture pack picker and settings (both kept in this browser's cookies) ----
app.get('/textures', (req, res) => html(res, pages.render('textures.html')));
app.post('/textures', (req, res) => res.json({ success: true }));
app.get('/settings', (req, res) => html(res, pages.render('settings.html')));
app.post('/settings', (req, res) => res.json({ success: true }));

// the real pages poll these; nothing to report locally
app.get('/flairlog', (req, res) => res.status(204).end());
app.get('/music', (req, res) => res.jsonp(music));

// real client + assets
app.use('/R-62bb0909b74c-z', express.static(path.join(PUBLIC, 'R-62bb0909b74c-z'), { index: false, maxAge: '365d', immutable: true }));
app.use('/events', express.static(path.join(PUBLIC, 'R-62bb0909b74c-z', 'events'), { index: false, maxAge: '7d' }));
app.use(express.static(PUBLIC, { index: false, maxAge: '7d' }));

// links on the real pages to things that don't exist here (groups, log in, leaderboards...): home
app.use((req, res) => (req.method === 'GET' ? res.redirect('/') : res.status(404).end()));

server.listen(PORT, HOST, () => console.log(`Local TagPro (single player) on http://localhost:${PORT}`));
