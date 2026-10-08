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
const p2p = require('./p2p');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0'; // the VPS service sets 127.0.0.1 so only Caddy is public
const PUBLIC = path.join(__dirname, '..', 'public');
const music = require(path.join(PUBLIC, 'music.json'));

const app = express();
const server = http.createServer(app);
// Anything that acts for a visitor must come from this site's own pages. Browsers count every
// other *.sslip.io address as the same "site", so SameSite cookies alone don't stop those.
function fromOtherSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return true;
  const o = req.headers.origin;
  if (!o) return false; // not a browser page (bots, P2P hosts, tests)
  try { return new URL(o).host !== (req.headers['x-forwarded-host'] || req.headers.host); } catch (e) { return true; }
}
const io = new Server(server, { transports: ['websocket', 'polling'], allowRequest: (req, ok) => ok(null, !fromOtherSite(req)) });

app.use(require('compression')());
app.use(express.urlencoded({ extended: true, limit: '50kb' }));
app.use((req, res, next) => (req.method !== 'GET' && req.method !== 'HEAD' && fromOtherSite(req) ? res.status(403).send('Requests from other sites are not allowed.') : next()));
app.use(sessions.middleware);
// links that change something (log out, leave group): ignored when another site sends the visitor
const ownLink = (req) => !fromOtherSite(req);

// log in / sign up attempts: per address (and per username for log ins), failures only
const attempts = new Map(); // key -> [timestamps]
function limited(key, max, ms) {
  const now = Date.now(), list = (attempts.get(key) || []).filter((t) => now - t < ms);
  attempts.set(key, list);
  return list.length >= max;
}
const note = (key) => attempts.set(key, (attempts.get(key) || []).concat(Date.now()));
setInterval(() => { const now = Date.now(); for (const [k, l] of attempts) if (!l.some((t) => now - t < 3600000)) attempts.delete(k); }, 600000).unref();
// the visitor's address: Caddy (on this machine) passes it in X-Forwarded-For
function clientIp(req) {
  const ip = req.socket.remoteAddress || '';
  if (!/^(::ffff:)?127\.|^::1$/.test(ip)) return ip;
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return fwd.length ? fwd[fwd.length - 1] : ip;
}

// started by `npm run host` (server/host.js): this PC runs a peer-to-peer group's games
if (process.env.P2P_CODE) {
  require('./hostlink').setup(app, { hub: process.env.P2P_HUB, code: process.env.P2P_CODE, url: process.env.P2P_URL, name: process.env.P2P_NAME });
}

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
// every page shows the logged-in name in the header. The request is tracked per request chain
// (AsyncLocalStorage), not in a shared variable: with async handlers (log in) another visitor's
// request could otherwise land in between and their name would be shown.
const _render = pages.render;
const requestStore = new (require('async_hooks').AsyncLocalStorage)();
const origin = (req) => req ? `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}` : '';
pages.render = (name, vars = {}) => {
  const req = requestStore.getStore();
  return _render(name, Object.assign({
    USER_NAME: req && req.session.account ? req.session.account.displayName : '',
    ORIGIN: pages.esc(origin(req)),
  }, vars));
};
app.use((req, res, next) => requestStore.run(req, next));

const card = (title, content, script) => pages.render('card.html', { TITLE: title, CARD: content, PAGE_SCRIPT: script || '/R-965af4e7a4b8-z/compact/global-settings.js' });

// ---- accounts (local username/password instead of the real site's OAuth logins) ----
app.get('/login', (req, res) => req.session.account ? res.redirect('/profile') : html(res, card('TagPro Log In', pages.loginCard())));
const TOO_MANY = 'Too many tries. Wait a few minutes and try again.';
app.post('/login', async (req, res) => {
  const ipKey = 'login-ip:' + clientIp(req), userKey = 'login-user:' + String(req.body.username || '').trim().toLowerCase();
  if (limited(ipKey, 10, 600000) || limited(userKey, 10, 600000)) return html(res, card('TagPro Log In', pages.loginCard(TOO_MANY)));
  const r = await accounts.login(req.body.username, req.body.password);
  if (r.error) { note(ipKey); note(userKey); return html(res, card('TagPro Log In', pages.loginCard(r.error))); }
  accounts.bind(sessions.rotate(req, res), r.account); // new cookie: an id seen before log in is worthless
  res.redirect('/');
});
app.post('/register', async (req, res) => {
  const ipKey = 'register-ip:' + clientIp(req);
  if (limited(ipKey, 5, 3600000)) return html(res, card('TagPro Log In', pages.loginCard(TOO_MANY)));
  const r = await accounts.register(req.body.username, req.body.password);
  if (r.error) return html(res, card('TagPro Log In', pages.loginCard(r.error)));
  note(ipKey);
  accounts.bind(sessions.rotate(req, res), r.account);
  res.redirect('/profile');
});
app.get('/logout', (req, res) => { if (ownLink(req)) { accounts.unbind(req.session); sessions.rotate(req, res); } res.redirect('/'); });
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
app.get('/leaders', (req, res) => html(res, card('TagPro Leaders', pages.leadersCard(accounts.rankedBoard()))));
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
  const invalid = req.query.invalid ? String(req.query.invalid) : '';
  const errors = [failed ? `Couldn't download from Fortunate Maps: ${failed}` : '', invalid ? `Not saved: ${invalid}` : ''].filter(Boolean).join(' ');
  html(res, card('TagPro Admin', admin.panel(req.query.saved ? 'Saved. The next public game uses these settings.' : '', errors)));
});
app.post('/admin', async (req, res) => {
  if (!admin.isAdmin(req.session)) return res.status(403).send('Not an admin');
  const { failed, invalid } = await admin.update(req.body, games.fetchFortunateMap, games.mapProblem);
  res.redirect('/admin?saved=1' + (failed.length ? '&failed=' + encodeURIComponent(failed.join(', ')) : '')
    + (invalid.length ? '&invalid=' + encodeURIComponent(invalid.join(' ')) : ''));
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

// ---- peer-to-peer groups: a second create button, a warning page before joining one, and the
// orange Peer to Peer box on the group page (agree / stop / leave / move to Chicago; hosting help)
const CREATE_BTN = '<button id="create-group-btn" class="btn btn-primary">Create Group</button>';
const P2P_CREATE_BTN = `
                        <button id="create-p2p-group-btn" class="btn btn-secondary" formaction="/groups/create-p2p" style="margin-top:8px"
                            title="Games run on a player's own PC instead of the Chicago server"
                            onclick="return confirm('Peer to peer: this group\\'s games will run on a player\\'s own PC, not the Chicago server. Whoever hosts can see and change anything in the game.\\n\\nEveryone who joins is warned and has to agree before they are sent to a game.\\n\\nCreate a peer-to-peer group?')">Create Peer to Peer Group</button>`;
const P2P_RISKS = `The host's PC runs the game, so the host can see and change anything in it (positions, scores, who gets
                    tagged) and can run their own code on the game page. Your account and login on this site stay safe either way.
                    Only play if you trust the host.`;
function p2pWarning(g) {
  const host = g.p2p && g.p2p.host;
  const id = pages.esc(g.id);
  return `
                        <h1 style="color:#f39c12">&#9888; Peer to Peer Group</h1>
                        <p style="font-size:17px"><b>${pages.esc(g.settings.name)}</b> plays its games on a player's own PC, <b>not the Chicago server</b>.
                        ${host ? `Right now they're hosted by <b>${pages.esc(host.name)}</b>.` : 'Nobody is hosting it yet.'}</p>
                        <p>${P2P_RISKS}</p>
                        <p>You can also join just to chat: you won't be sent to any game until you agree, and you can change your mind on the group page.</p>
                        <form method="post" action="/groups/${id}/p2p" style="margin-top:18px">
                            <button class="btn btn-primary" name="choice" value="agree">I trust the host: join and play</button>
                            <button class="btn btn-default" name="choice" value="watch">Join, but don't send me to games</button>
                            <a class="btn btn-default" href="/groups">No thanks</a>
                        </form>`;
}
const P2P_PANEL_AT = '    <div class="row">\n\n        <!-- start player list area -->';
const P2P_PANEL = `    <div class="row" id="p2p-panel" style="display:none">
        <div class="col-xs-12">
            <div style="margin:10px 0;padding:12px 16px;border:2px solid #f39c12;border-radius:6px;background:rgba(243,156,18,.12)">
                <div style="font-size:18px;color:#f39c12"><b>&#9888; PEER TO PEER GROUP</b>: games here don't run on the Chicago server.</div>
                <div id="p2p-state" style="margin-top:4px"></div>
                <div style="margin-top:6px;opacity:.85">${P2P_RISKS}</div>
                <div id="p2p-consent" style="margin-top:10px"></div>
                <div id="p2p-leader" style="display:none;margin-top:10px">
                    <div id="p2p-waiting"></div>
                    <button id="p2p-chicago" class="btn btn-default btn-tiny" type="button" style="margin-top:6px">Move this group to the Chicago server</button>
                    <div style="margin-top:10px">
                        To host this group's games on your PC, install <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js</a>, then run this in a terminal
                        (Command Prompt on Windows). No router setup needed. Keep the window open while you play.
                        <pre id="p2p-cmd" style="margin:8px 0;white-space:pre-wrap;user-select:all"></pre>
                        <button id="p2p-copy" class="btn btn-default btn-tiny" type="button">Copy</button>
                        <span style="opacity:.75">Already downloaded it? Run <code>git pull</code> in that folder, then just the last line. Keep the code to yourself: anyone with it can host this group.</span>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <script>
    (function p2p() {
        var s = window.tagpro && tagpro.group && tagpro.group.socket;
        if (!s) return setTimeout(p2p, 200);
        var esc = function (t) { return $('<div>').text(t).html(); };
        s.on('p2p', function (st) {
            $('#p2p-panel').toggle(!!st.on);
            $('#p2p-state').html(st.connected
                ? 'Games are hosted on <b>' + esc(st.hostName) + '</b>\\'s PC (<span style="opacity:.75">' + esc(st.url) + '</span>).'
                : 'Nobody is hosting yet.' + (st.code ? '' : ' The group leader can host from their PC.'));
            $('#p2p-consent').html(st.agreed
                ? '<b style="color:#8bc34a">&#10003; You agreed to be sent to this group\\'s peer-to-peer games.</b> '
                  + '<button class="btn btn-default btn-tiny" type="button" data-agree="false">Stop sending me to games</button>'
                : '<b>You will not be sent to games in this group until you agree.</b><br>'
                  + '<button class="btn btn-primary btn-tiny" type="button" data-agree="true" style="margin-top:6px">I trust the host: send me to games</button> '
                  + '<a class="btn btn-default btn-tiny" href="/groups/leave" style="margin-top:6px">Leave group</a>');
            $('#p2p-leader').toggle(!!st.code);
            $('#p2p-waiting').html(st.notAgreed && st.notAgreed.length
                ? 'Haven\\'t agreed yet (won\\'t be sent to games): <b>' + st.notAgreed.map(esc).join(', ') + '</b>' : '');
            if (st.code) $('#p2p-cmd').text('git clone https://github.com/BambiTP/tagpro-local\\ncd tagpro-local\\nnpm install\\nnpm run host -- ' + st.code);
        });
        $('#p2p-consent').on('click', '[data-agree]', function () { s.emit('p2pAgree', $(this).data('agree') === true); });
        $('#p2p-chicago').click(function () { s.emit('setting', { name: 'server', value: 'chicago' }); });
        $('#p2p-copy').click(function () { navigator.clipboard && navigator.clipboard.writeText($('#p2p-cmd').text()); $(this).text('Copied'); });
        s.emit('p2pStatus'); // anything sent before this script ran
    })();
    </script>
`;

app.get(['/groups', '/groups/'], (req, res) => {
  const list = [...groups.groups.values()].filter((g) => g.settings.discoverable && g.members.size).map(pages.groupItem).join('\n');
  html(res, pages.render('groups.html', { GROUPS_LIST: list }).replace(CREATE_BTN, CREATE_BTN + P2P_CREATE_BTN));
});

function createGroup(req, res, opts) {
  groups.leave(req.session);
  const g = new groups.Group(opts);
  if (opts.preset) g.applyPreset(opts.preset);
  if (opts.p2p) { Object.assign(g.settings, { serverSelect: true, server: 'p2p' }); req.session.p2pConsent = g.id; } // the creator agreed in the confirm box
  res.redirect('/groups/' + g.id);
}
const groupForm = (req, p2pGroup) => ({
  name: req.body.name, discoverable: req.body.public === 'on', isPrivate: req.body.private === 'on', preset: req.body.preset, p2p: p2pGroup,
});
app.post('/groups/create', (req, res) => createGroup(req, res, groupForm(req, false)));
// games on a player's own PC instead of this server (see p2p.js)
app.post('/groups/create-p2p', (req, res) => createGroup(req, res, groupForm(req, true)));
app.get('/groups/create', (req, res) => createGroup(req, res, { name: '', isPrivate: true, discoverable: false, preset: req.query.preset }));
app.get('/groups/leave', (req, res) => { if (ownLink(req)) groups.leave(req.session); res.redirect('/groups'); });

app.get('/groups/:id', (req, res, next) => {
  if (!/^[a-z]{8}$/.test(req.params.id)) return next();
  const g = groups.groups.get(req.params.id);
  if (!g) return res.redirect('/groups');
  // peer to peer: warn before joining; the choice (a button on the warning page, never a link, so
  // nobody can be signed up by a crafted URL) is remembered for this group
  if (p2p.isP2P(g) && !g.members.has(req.session.publicId)) {
    if (req.session.p2pSeen !== g.id && req.session.p2pConsent !== g.id) return html(res, card('Peer to Peer Group', p2pWarning(g)));
  }
  if (req.session.groupId && req.session.groupId !== g.id) groups.leave(req.session);
  html(res, pages.render('group.html', { GROUP_ID: g.id, GROUP_NAME: pages.esc(g.settings.name) }).replace(P2P_PANEL_AT, P2P_PANEL + P2P_PANEL_AT));
});

app.post('/groups/:id/p2p', (req, res) => {
  const g = /^[a-z]{8}$/.test(req.params.id) && groups.groups.get(req.params.id);
  if (!g) return res.redirect('/groups');
  if (req.body.choice === 'agree' || req.body.choice === 'watch') {
    req.session.p2pConsent = req.body.choice === 'agree' ? g.id : null;
    req.session.p2pSeen = g.id;
  }
  res.redirect('/groups/' + g.id);
});

// group map upload (layout png + logic json), like tagpro.koalabeast.com/groups/testmap
const upload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 2, fields: 10, parts: 12 } });
app.post('/groups/testmap', upload.fields([{ name: 'layout', maxCount: 1 }, { name: 'logic', maxCount: 1 }]), (req, res) => {
  const g = req.session.groupId && groups.groups.get(req.session.groupId);
  const m = g && g.members.get(req.session.publicId);
  if (!m || !m.leader) return res.json({ success: false, error: 'Only the group leader can upload a map.' });
  const layout = req.files && req.files.layout && req.files.layout[0], logic = req.files && req.files.logic && req.files.logic[0];
  if (!layout || !logic) return res.json({ success: false, error: 'You must upload both layout and logic files' });
  try {
    const json = JSON.parse(logic.buffer.toString('utf8'));
    games.checkPngSize(layout.buffer); // before decoding: a small file can decode to a huge image
    require('pngjs').PNG.sync.read(require('../engine/mapLoader').trimPng(layout.buffer));
    const key = 'upload-' + g.id + '-' + Date.now();
    require('fs').writeFileSync(path.join(__dirname, '..', 'maps', key + '.png'), layout.buffer);
    require('fs').writeFileSync(path.join(__dirname, '..', 'maps', key + '.json'), JSON.stringify(json));
    const problem = games.mapProblem(key);
    if (problem) {
      for (const ext of ['png', 'json']) require('fs').unlinkSync(path.join(__dirname, '..', 'maps', key + '.' + ext));
      return res.json({ success: false, error: problem });
    }
    g.settings.map = 'upload/' + key; g.broadcastSetting('map');
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e instanceof games.MapError ? e.message : 'Invalid map files' }); }
});

app.get('/games/find', (req, res) => {
  const g = req.session.groupId && groups.groups.get(req.session.groupId);
  // ?type=ranked: the Eggball Ranked queue (logged in only); anything else is casual Play Now
  const type = req.query.type === 'ranked' ? 'ranked' : 'casual';
  if (type === 'ranked' && !g && !req.session.account) return res.redirect('/login');
  req.session.joinType = type;
  const r = req.session.account ? accounts.rankedOf(req.session.account) : null;
  html(res, pages.render('find.html', {
    GROUP_ID: g ? g.id : 'null', PRIVATE_GROUP: g && g.settings.isPrivate ? 'true' : '', JOIN_TYPE: type,
    CASUAL_ACTIVE: type === 'casual' ? 'btn-primary' : 'btn-default', RANKED_ACTIVE: type === 'ranked' ? 'btn-primary' : 'btn-default',
    RANKED_INFO: type === 'ranked' && r ? `Your eggball rating: <b>${r.rating}</b>` : '',
  }));
});

app.get('/game', (req, res, next) => {
  // /game?replay=<key>: the real game page in replay mode
  if (req.query.replay) return html(res, withTextures(req, pages.render('replay.html', { REPLAY_KEY: pages.esc(String(req.query.replay).slice(0, 80)) })));
  next();
});
// eggball (an event mode): like the real site, the game page itself carries the event's script,
// tile/splat textures, images and sounds (the live client ignores clientInfo's event lists)
const { EGG_CLIENT_INFO } = require('../engine/game');
const CB = '/R-62bb0909b74c-z';
function eggballPage(h) {
  const ci = EGG_CLIENT_INFO;
  for (const [id, src] of Object.entries(ci.eventTextures)) h = h.replace(new RegExp(`(<img id="${id}" src=")[^"]*(")`), `$1${CB + src}$2`);
  const assets = ci.eventGraphics.map((g) => `\n        <img id="${g.id}" src="${CB + g.src}" class="asset">`).join('')
    + ci.eventSounds.map((a) => `\n        <audio id="${a.id}" preload="auto">` + ['mp3', 'm4a', 'ogg'].map((e) => `<source src="${CB + a.src}.${e}" type="audio/${e}">`).join('') + '</audio>').join('');
  return h.replace('<div id="assets">', '<div id="assets">' + assets);
}
app.get('/game', (req, res) => {
  const pg = req.session.pendingGame;
  const room = pg && games.games.get(pg.id);
  if (!room || room.closed) return res.redirect('/');
  const GG = '<script src="/R-62bb0909b74c-z/compact/global-game.js"></script>';
  const extra = (room.egg ? EGG_CLIENT_INFO.eventScripts.map((p) => `\n        <script src="${CB + p}"></script>`).join('') : '')
    + (room.gravity ? '\n        <script src="/R-62bb0909b74c-z/scripts/gravity.js"></script>' : '')
    // Eggball Ranked: double-tap Shift votes to keep playing after a teammate leaves
    + (room.ranked ? '\n        <script>(function () { var last = 0; document.addEventListener("keydown", function (e) { if (e.key !== "Shift" || e.repeat) return; var n = Date.now(); if (n - last < 400) { last = 0; if (tagpro.socket) tagpro.socket.emit("rankedContinue"); } else last = n; }); })();</script>' : '')
    + (room.localTrust ? '\n        <script>tagproConfig.localTrust = ' + JSON.stringify(room.trustConfig()).replace(/</g, '\\u003c') + ';</script><script src="/localtrust.js?v=' + Math.floor(require('fs').statSync(path.join(PUBLIC, 'localtrust.js')).mtimeMs) + '"></script>' : '');
  let page = (h) => (room.egg ? eggballPage(h) : h).replace(GG, GG + extra);
  if (process.env.P2P_CODE) { // this PC is a peer-to-peer host: say so on the game itself
    const who = require('./hostlink').hostName();
    const tag = `<div style="position:fixed;top:4px;left:50%;transform:translateX(-50%);z-index:9999;pointer-events:none;padding:2px 10px;border-radius:4px;background:rgba(243,156,18,.85);color:#000;font:bold 12px sans-serif">PEER TO PEER GAME: hosted on ${pages.esc(who || 'a player')}'s PC, not the Chicago server</div>`;
    const inner = page;
    page = (h) => inner(h).replace(/<body[^>]*>/, (b) => b + tag);
  }
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
app.get('/queue/status', (req, res) => res.json(require(req.query.type === 'ranked' ? './ranked' : './queue').counts()));

// music list (JSONP, like tagpro.koalabeast.com/music)
app.get('/music', (req, res) => res.jsonp(music));

// real client + assets
// cache-busted paths (/R-<hash>/...) never change; textures/sounds/music change only with the mirror
app.use('/R-62bb0909b74c-z', express.static(path.join(PUBLIC, 'R-62bb0909b74c-z'), { index: false, maxAge: '365d', immutable: true }));
// event scripts (eggball) load some images by page-relative paths, e.g. "events/easter-2016/images/egg.png"
app.use('/events', express.static(path.join(PUBLIC, 'R-62bb0909b74c-z', 'events'), { index: false, maxAge: '7d' }));
app.use(express.static(PUBLIC, { index: false, maxAge: '7d' }));

if (!process.env.P2P_CODE) p2p.attach(io, groups.groups);
// a P2P host's PC only runs the games the main site sends it: no groups or Play Now queue of its own
if (!process.env.P2P_CODE) groups.attach(io, { launchGroupGame: (g) => games.launchGroupGame(g).catch((e) => console.error('launch failed', e)), endGame: games.endGame });
if (!process.env.P2P_CODE) games.attachJoiner(io);
mapstats.attach(io, replays.index);
games.attachGames(io);

server.listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`TagPro local server on http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  LAN: http://${ip}:${PORT}`);
});
