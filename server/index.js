// index.js - local TagPro server: serves the real client pages + recoded group/joiner/game sockets.
const http = require('http');
const path = require('path');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const sessions = require('./sessions');
const pages = require('./pages');
const groups = require('./groups');
const games = require('./games');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0'; // the VPS service sets 127.0.0.1 so only Caddy is public
const PUBLIC = path.join(__dirname, '..', 'public');
const music = require(path.join(PUBLIC, 'music.json'));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { transports: ['websocket', 'polling'], cors: { origin: true, credentials: true } });

app.use(require('compression')());
app.use(express.urlencoded({ extended: false }));
app.use(sessions.middleware);

pages.setStatsProvider(() => {
  const live = [...games.games.values()].filter((r) => !r.closed);
  return {
    STATS_PLAYERS: live.reduce((n, r) => n + r.playerCount(), 0),
    STATS_GAMES: live.length,
    STATS_ONLINE: io.engine.clientsCount,
  };
});

const html = (res, s) => res.type('html').send(s);

app.get('/', (req, res) => html(res, pages.render('home.html', { GROUP_ID: req.session.groupId || 'null' })));

app.get(['/groups', '/groups/'], (req, res) => {
  const list = [...groups.groups.values()].filter((g) => g.settings.discoverable && g.members.size).map(pages.groupItem).join('\n');
  html(res, pages.render('groups.html', { GROUPS_LIST: list }));
});

function createGroup(req, res, opts) {
  groups.leave(req.session);
  const g = new groups.Group(opts);
  if (opts.preset) g.applyPreset(opts.preset);
  res.redirect('/groups/' + g.id);
}
app.post('/groups/create', (req, res) => createGroup(req, res, {
  name: req.body.name, discoverable: req.body.public === 'on', isPrivate: req.body.private === 'on', preset: req.body.preset,
}));
app.get('/groups/create', (req, res) => createGroup(req, res, { name: '', isPrivate: true, discoverable: false, preset: req.query.preset }));
app.get('/groups/leave', (req, res) => { groups.leave(req.session); res.redirect('/groups'); });

app.get('/groups/:id', (req, res, next) => {
  if (!/^[a-z]{8}$/.test(req.params.id)) return next();
  const g = groups.groups.get(req.params.id);
  if (!g) return res.redirect('/groups');
  if (req.session.groupId && req.session.groupId !== g.id) groups.leave(req.session);
  html(res, pages.render('group.html', { GROUP_ID: g.id, GROUP_NAME: pages.esc(g.settings.name) }));
});

// group map upload (layout png + logic json), like tagpro.koalabeast.com/groups/testmap
const upload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
app.post('/groups/testmap', upload.fields([{ name: 'layout' }, { name: 'logic' }]), (req, res) => {
  const g = req.session.groupId && groups.groups.get(req.session.groupId);
  const m = g && g.members.get(req.session.id);
  if (!m || !m.leader) return res.json({ success: false, error: 'Only the group leader can upload a map.' });
  const layout = req.files && req.files.layout && req.files.layout[0], logic = req.files && req.files.logic && req.files.logic[0];
  if (!layout || !logic) return res.json({ success: false, error: 'You must upload both layout and logic files' });
  try {
    const json = JSON.parse(logic.buffer.toString('utf8'));
    require('pngjs').PNG.sync.read(layout.buffer);
    const key = 'upload-' + g.id + '-' + Date.now();
    require('fs').writeFileSync(path.join(__dirname, '..', 'maps', key + '.png'), layout.buffer);
    require('fs').writeFileSync(path.join(__dirname, '..', 'maps', key + '.json'), JSON.stringify(json));
    g.settings.map = 'upload/' + key; g.broadcastSetting('map');
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: 'Invalid map files' }); }
});

app.get('/games/find', (req, res) => html(res, pages.render('find.html', { GROUP_ID: req.session.groupId || 'null' })));

app.get('/game', (req, res) => {
  const pg = req.session.pendingGame;
  const room = pg && games.games.get(pg.id);
  if (!room || room.closed) return res.redirect('/');
  html(res, pages.render('game.html', {
    GAME_SOCKET: '/game/' + room.id, GAME_SERVER: 'local', GAME_ID: room.id,
    GAME_SOCKET_LABEL: req.headers.host, GROUP_ID: room.groupId || 'null',
  }));
});

// flair feed (server-sent events); no accounts locally, so it just stays open
app.get('/flairlog', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': ok\n\n');
  const t = setInterval(() => res.write(': ping\n\n'), 30000);
  req.on('close', () => clearInterval(t));
});

// local-only helper (not on the real site): set this session's display name, used by bots
app.post('/local/name', (req, res) => {
  const n = String(req.body.name || '').trim().slice(0, 12);
  if (n) req.session.name = n;
  res.json({ name: req.session.name });
});

// music list (JSONP, like tagpro.koalabeast.com/music)
app.get('/music', (req, res) => res.jsonp(music));

// real client + assets
// cache-busted paths (/R-<hash>/...) never change; textures/sounds/music change only with the mirror
app.use('/R-62bb0909b74c-z', express.static(path.join(PUBLIC, 'R-62bb0909b74c-z'), { index: false, maxAge: '365d', immutable: true }));
app.use(express.static(PUBLIC, { index: false, maxAge: '7d' }));

groups.attach(io, { launchGroupGame: (g) => games.launchGroupGame(g).catch((e) => console.error('launch failed', e)), endGame: games.endGame });
games.attachJoiner(io);
games.attachGames(io);

server.listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`TagPro local server on http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  LAN: http://${ip}:${PORT}`);
});
