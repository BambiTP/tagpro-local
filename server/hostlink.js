// hostlink.js - this copy of tagpro-local hosting a peer-to-peer group's games (started by
// server/host.js). It stays connected to the main site, creates the group's games here when the
// leader launches, and turns each player's ticket into a local session. Group, home and account
// pages belong to the main site, so requests for them are sent back there.
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const games = require('./games');

const MAPS_DIR = path.join(__dirname, '..', 'maps');
const HUB_PAGES = /^\/(?:$|groups|games\/find|login|register|logout|profile|feedback|playersearch|admin)/;

// called before the site's own routes
function setup(app, { hub, code, url, name }) {
  const tickets = new Map(); // ticket -> { gameId, name, auth, flair, degree, team, spectate }

  app.get('/p2p/ping', (req, res) => res.json({ tagproLocalHost: true }));
  app.get('/p2p/join', (req, res) => {
    const t = tickets.get(String(req.query.t || ''));
    const room = t && games.games.get(t.gameId);
    if (!room || room.ended) return res.redirect(hub + '/groups');
    Object.assign(req.session, { name: t.name, auth: t.auth, flair: t.flair, degree: t.degree });
    req.session.pendingGame = { id: t.gameId, team: t.team, spectate: t.spectate };
    res.redirect('/game');
  });
  app.use((req, res, next) => (req.method === 'GET' && HUB_PAGES.test(req.path) ? res.redirect(hub + req.originalUrl) : next()));

  // a new tunnel address can take a minute to answer; only introduce ourselves once it does
  waitReachable(url).then(() => connect({ hub, code, url, name, tickets }));
}

async function waitReachable(url) {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(url + '/p2p/ping', { signal: AbortSignal.timeout(5000) })).ok) return; } catch (e) { /* not yet */ }
    if (i === 1) console.log('Waiting for the public address to come online (can take a minute) ...');
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  console.error(`\nHosting stopped: ${url} never answered. Check your firewall, or try again.`);
  process.exit(1);
}

function connect({ hub, code, url, name, tickets }) {
  const socket = io(hub + '/p2p-host', { auth: { code, url, name }, transports: ['websocket'], reconnectionDelayMax: 10000 });
  socket.on('connect', () => console.log(`Connected to ${hub}; checking that players can reach ${url} ...`));
  socket.on('accepted', (d) => console.log(`\nHosting games for the group "${d.groupName}" (${hub}/groups/${d.groupId}).\nLeave this window open while you play; close it to stop hosting.\n`));
  socket.on('rejected', (why) => { console.error('\nHosting stopped: ' + why); process.exit(1); });
  socket.on('disconnect', (reason) => { if (reason !== 'io server disconnect') console.log('Lost the main site; reconnecting ...'); });

  socket.on('launch', async (d, ack) => {
    try {
      const f = d.mapFiles;
      if (f && /^upload-[a-z]{8}-\d+$/.test(f.key)) {
        fs.writeFileSync(path.join(MAPS_DIR, f.key + '.png'), Buffer.from(f.png, 'base64'));
        fs.writeFileSync(path.join(MAPS_DIR, f.key + '.json'), f.json);
      }
      const mapKey = await games.resolveMap(d.modeMap || d.settings.map).catch(() => games.resolveMap('random'));
      const room = games.createGame({
        mapKey, settings: d.settings, isPrivate: d.settings.isPrivate, groupId: d.groupId,
        onFinish: (id) => {
          socket.emit('ended', id);
          for (const [k, t] of tickets) if (t.gameId === id) tickets.delete(k);
        },
      });
      for (const t of d.tickets) tickets.set(t.ticket, { ...t, gameId: room.id });
      ack({ gameId: room.id });
    } catch (e) {
      console.error('launch failed', e);
      ack({ error: e.message });
    }
  });
  socket.on('ticket', (d, ack) => {
    const room = games.games.get(d.gameId);
    if (!room || room.ended) return ack({ error: 'game over' });
    tickets.set(d.ticket.ticket, { ...d.ticket, gameId: room.id });
    ack({ ok: true });
  });
  socket.on('endGame', (id) => games.endGame(id));
}

module.exports = { setup };
