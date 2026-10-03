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
const accounts = require('./accounts');
const replays = require('./replays');
const community = require('./community');
const mapstats = require('./mapstats');
const admin = require('./admin');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0'; // the VPS service sets 127.0.0.1 so only Caddy is public
const PUBLIC = path.join(__dirname, '..', 'public');
const music = require(path.join(PUBLIC, 'music.json'));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { transports: ['websocket', 'polling'], cors: { origin: true, credentials: true } });

app.use(require('compression')());
app.use(express.urlencoded({ extended: true }));
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

// ---- texture packs: the real picker stores the chosen pack (image URLs) in the "textures"
// cookie; game/replay pages are rendered with those images. Default matches the real site.
const PACKS = require(path.join(__dirname, '..', 'ref-data', 'texture-packs.json'));
const DEFAULT_PACK = PACKS.find((p) => p.name === "Muscle's Cup Gradients") || PACKS[0];
const ASSET_IDS = { tiles: 'tiles', splats: 'splats', speedpad: 'speedpad', speedpadRed: 'speedpadred', speedpadBlue: 'speedpadblue', portal: 'portal', portalRed: 'portalred', portalBlue: 'portalblue' };
const okUrl = (u) => typeof u === 'string' && (/^\/textures\/[\w-]+\/[\w-]+\.png$/.test(u) || /^https:\/\/[^"'<>\s]+$/.test(u));
function chosenPack(req) {
  let pack = req.session.account && req.session.account.textures;
  if (!pack) { try { pack = JSON.parse(sessions.parseCookies(req.headers.cookie).textures || 'null'); } catch (e) { pack = null; } }
  return pack && typeof pack === 'object' ? pack : DEFAULT_PACK;
}
function withTextures(req, page) {
  const pack = chosenPack(req);
  for (const [key, id] of Object.entries(ASSET_IDS)) {
    const url = okUrl(pack[key]) ? pack[key] : DEFAULT_PACK[key];
    page = page.replace(new RegExp(`(<img id="${id}" src=")[^"]*(")`), `$1${pages.esc(url)}$2`);
  }
  return page;
}
// every page shows the logged-in name in the header
const _render = pages.render;
let currentReq = null;
const origin = (req) => req ? `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}` : '';
pages.render = (name, vars = {}) => _render(name, Object.assign({
  USER_NAME: currentReq && currentReq.session.account ? currentReq.session.account.displayName : '',
  ORIGIN: origin(currentReq),
}, vars));
app.use((req, res, next) => { currentReq = req; next(); });

const card = (title, content, script) => pages.render('card.html', { TITLE: title, CARD: content, PAGE_SCRIPT: script || '/R-965af4e7a4b8-z/compact/global-settings.js' });

// ---- accounts (local username/password instead of the real site's OAuth logins) ----
app.get('/login', (req, res) => req.session.account ? res.redirect('/profile') : html(res, card('TagPro Log In', pages.loginCard())));
app.post('/login', (req, res) => {
  const r = accounts.login(req.body.username, req.body.password);
  if (r.error) return html(res, card('TagPro Log In', pages.loginCard(r.error)));
  accounts.bind(req.session, r.account);
  res.redirect('/');
});
app.post('/register', (req, res) => {
  const r = accounts.register(req.body.username, req.body.password);
  if (r.error) return html(res, card('TagPro Log In', pages.loginCard(r.error)));
  accounts.bind(req.session, r.account);
  res.redirect('/profile');
});
app.get('/logout', (req, res) => { accounts.unbind(req.session); res.redirect('/'); });
app.get('/profile', (req, res) => {
  if (!req.session.account) return res.redirect('/login');
  html(res, card('TagPro Profile', pages.profileCard(req.session.account, accounts.flairs), '/R-965af4e7a4b8-z/compact/global-profile.js'));
});
app.post('/profile', (req, res) => {
  const r = accounts.setDisplayName(req.session, req.body.displayedName);
  if (r.error) return res.json(r);
  res.json({ success: true, reservedName: req.session.account.username, displayName: req.session.account.displayName });
});
app.post('/profile/selectedFlair', (req, res) => res.json(accounts.setFlair(req.session, req.body.flair)));

// ---- replays ----
app.get('/replays', (req, res) => html(res, pages.render('replays.html', { USER_ID: req.session.account ? req.session.account.id : '' })));
app.get('/replays/data', (req, res) => res.json(replays.list(req.query, req.session.account && req.session.account.id)));
app.get('/replays/gameFile', (req, res) => {
  const id = req.query.key ? replays.keyToGameId(req.query.key) : String(req.query.gameId || '');
  const f = replays.file(id);
  if (!f) { res.set('X-Replay-Error', 'Replay not found'); return res.status(404).send('Replay not found'); }
  res.set('X-Replay-Filename', f.name);
  if (!req.query.key) res.attachment(f.name.replace(/[^\w .-]/g, '_') + '.ndjson');
  res.type('text/plain').send(replays.ensureId(require('fs').readFileSync(f.path, 'utf8')));
});

// ---- feedback (login required to post) ----
app.get('/feedback', (req, res) => html(res, card('TagPro Feedback', community.feedbackCard(req.session.account))));
app.post('/feedback', (req, res) => {
  if (!req.session.account) return res.redirect('/login');
  const r = community.createThread(req.session.account, req.body.body);
  if (r.error) return html(res, card('TagPro Feedback', community.feedbackCard(req.session.account, r.error)));
  res.redirect('/feedback/' + r.thread.id);
});
app.get('/feedback/:id', (req, res) => {
  const c = community.threadCard(req.params.id, req.session.account);
  if (!c) return res.redirect('/feedback');
  html(res, card('TagPro Feedback', c));
});
app.post('/feedback/:id/reply', (req, res) => {
  if (!req.session.account) return res.redirect('/login');
  const r = community.reply(req.session.account, req.params.id, req.body.body);
  if (r.error) return html(res, card('TagPro Feedback', community.threadCard(req.params.id, req.session.account, r.error) || ''));
  res.redirect('/feedback/' + req.params.id);
});

// ---- player search + public profiles ----
app.get('/playersearch', (req, res) => html(res, card('TagPro Player Search', community.searchCard(req.query.q, accounts.search(req.query.q)))));
app.get('/profile/:id', (req, res) => {
  const a = accounts.byId(req.params.id);
  if (!a) return res.redirect('/playersearch');
  html(res, card('TagPro Profile', community.publicProfileCard(a, a.flair ? accounts.flairByKey[a.flair] : null, replays.gamesFor(a.id))));
});

// ---- admin control panel (public game map/settings) ----
app.get('/admin', (req, res) => {
  if (!admin.isAdmin(req.session)) return req.session.account ? res.status(403).send('Not an admin') : res.redirect('/login');
  const failed = req.query.failed ? String(req.query.failed) : '';
  html(res, card('TagPro Admin', admin.panel(req.query.saved ? 'Saved. The next public game uses these settings.' : '', failed ? `Couldn't download from Fortunate Maps: ${failed}` : '')));
});
app.post('/admin', async (req, res) => {
  if (!admin.isAdmin(req.session)) return res.status(403).send('Not an admin');
  const failed = await admin.update(req.body, games.fetchFortunateMap);
  res.redirect('/admin?saved=1' + (failed.length ? '&failed=' + encodeURIComponent(failed.join(', ')) : ''));
});
app.post('/admin/reset', (req, res) => {
  if (!admin.isAdmin(req.session)) return res.status(403).send('Not an admin');
  admin.reset(); res.redirect('/admin?saved=1');
});

// ---- maps page (real page; data from this server) ----
app.get('/maps', (req, res) => html(res, pages.render('maps.html')));
app.get('/maps.json', (req, res) => res.json(mapstats.allMapData()));

// ---- texture pack picker ----
app.get('/textures', (req, res) => html(res, pages.render('textures.html')));
app.post('/textures', (req, res) => {
  if (req.session.account) { require('./accounts').setTextures(req.session, req.body); }
  res.json({ success: true });
});

// settings are browser cookies; the real page just posts for an acknowledgement
app.get('/settings', (req, res) => html(res, pages.render('settings.html')));
app.post('/settings', (req, res) => res.json({ success: true }));

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
    require('pngjs').PNG.sync.read(require('../engine/mapLoader').trimPng(layout.buffer));
    const key = 'upload-' + g.id + '-' + Date.now();
    require('fs').writeFileSync(path.join(__dirname, '..', 'maps', key + '.png'), layout.buffer);
    require('fs').writeFileSync(path.join(__dirname, '..', 'maps', key + '.json'), JSON.stringify(json));
    g.settings.map = 'upload/' + key; g.broadcastSetting('map');
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: 'Invalid map files' }); }
});

app.get('/games/find', (req, res) => {
  const g = req.session.groupId && groups.groups.get(req.session.groupId);
  html(res, pages.render('find.html', { GROUP_ID: g ? g.id : 'null', PRIVATE_GROUP: g && g.settings.isPrivate ? 'true' : '' }));
});

app.get('/game', (req, res, next) => {
  // /game?replay=<key>: the real game page in replay mode
  if (req.query.replay) return html(res, withTextures(req, pages.render('replay.html', { REPLAY_KEY: pages.esc(String(req.query.replay).slice(0, 80)) })));
  next();
});
app.get('/game', (req, res) => {
  const pg = req.session.pendingGame;
  const room = pg && games.games.get(pg.id);
  if (!room || room.closed) return res.redirect('/');
  const page = (h) => room.gravity ? h.replace('<script src="/R-62bb0909b74c-z/compact/global-game.js"></script>', '<script src="/R-62bb0909b74c-z/compact/global-game.js"></script>\n        <script src="/R-62bb0909b74c-z/scripts/gravity.js"></script>') : h;
  html(res, page(withTextures(req, pages.render('game.html', {
    GAME_SOCKET: '/game/' + room.id, GAME_SERVER: 'local', GAME_ID: room.id,
    GAME_SOCKET_LABEL: req.headers.host, GROUP_ID: room.groupId || 'null',
  }))));
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

// public queue status for the homepage (Play Now)
app.get('/queue/status', (req, res) => res.json(require('./queue').counts()));

// music list (JSONP, like tagpro.koalabeast.com/music)
app.get('/music', (req, res) => res.jsonp(music));

// real client + assets
// cache-busted paths (/R-<hash>/...) never change; textures/sounds/music change only with the mirror
app.use('/R-62bb0909b74c-z', express.static(path.join(PUBLIC, 'R-62bb0909b74c-z'), { index: false, maxAge: '365d', immutable: true }));
app.use(express.static(PUBLIC, { index: false, maxAge: '7d' }));

groups.attach(io, { launchGroupGame: (g) => games.launchGroupGame(g).catch((e) => console.error('launch failed', e)), endGame: games.endGame });
games.attachJoiner(io);
mapstats.attach(io, replays.index);
games.attachGames(io);

server.listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`TagPro local server on http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  LAN: http://${ip}:${PORT}`);
});
