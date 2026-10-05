// p2p.js - peer-to-peer groups, main-site side. A P2P group's games run on a player's own PC:
// they start tagpro-local there with `npm run host -- <code>` (server/host.js), which connects
// here on the /p2p-host socket. The group page still lives on this site; when the leader launches,
// the game is created on the host and each player is sent there with a one-game ticket that
// carries their name, flair and team (the host has no accounts of its own).
// Nobody is sent to a P2P game without agreeing first: each member has a p2pOk flag, set by the
// warning page before joining (session.p2pConsent) or the Agree button on the group page, and
// cleared for everyone else whenever the group switches to Peer to Peer.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAPS_DIR = path.join(__dirname, '..', 'maps');
const byCode = new Map(); // host code -> group

const isP2P = (g) => g.settings.server === 'p2p';

function state(g) {
  if (!g.p2p) {
    g.p2p = { code: crypto.randomBytes(9).toString('base64url'), host: null, launching: false };
    byCode.set(g.p2p.code, g);
  }
  return g.p2p;
}

// what the group page's Peer to Peer box shows member m; only the leader is given the host code
// and the list of members who haven't agreed
function status(g, m) {
  const h = state(g).host;
  return {
    on: isP2P(g), connected: !!h, hostName: h ? h.name : null, url: h ? h.url : null, agreed: !!m.p2pOk,
    code: m.leader ? g.p2p.code : null,
    notAgreed: m.leader ? g.memberList().filter((o) => !o.p2pOk).map((o) => o.name) : null,
  };
}
function sendStatus(g, m) { for (const s of m.sockets) s.emit('p2p', status(g, m)); }
function tell(m, message) { for (const s of m.sockets) s.emit('chat', { from: null, message, to: 'group', auth: null }); }

// member m agrees (or stops agreeing) to be sent to this group's peer-to-peer games
function agree(g, m, ok) {
  m.session.p2pConsent = ok ? g.id : null; // remembered if they leave and come back
  if (!!m.p2pOk === ok) return sendStatus(g, m);
  m.p2pOk = ok;
  if (isP2P(g)) g.systemChat(ok ? `${m.name} agreed to play peer-to-peer games.` : `${m.name} won't be sent to peer-to-peer games.`);
  broadcastStatus(g);
}

// the group's server setting changed (by member `by`, or by a preset when null)
function serverChanged(g, by, was) {
  if (isP2P(g) && was !== 'p2p') {
    for (const m of g.members.values()) {
      m.p2pOk = m === by;
      if (m.p2pOk) m.session.p2pConsent = g.id;
      else if (m.session.p2pConsent === g.id) m.session.p2pConsent = null;
    }
    g.systemChat('This group now plays PEER TO PEER: games run on a player\'s own PC, not the Chicago server. '
      + 'Nobody is sent to a game until they agree in the orange box at the top of the page.');
  } else if (!isP2P(g) && was === 'p2p') {
    g.systemChat('This group is back on the Chicago server.');
  }
  broadcastStatus(g);
}
function broadcastStatus(g) { for (const m of g.members.values()) sendStatus(g, m); }

function ticket(session, team, spectate) {
  return {
    ticket: crypto.randomBytes(16).toString('base64url'),
    name: session.name, auth: !!session.auth, flair: session.flair || null, degree: session.degree || 0,
    team, spectate,
  };
}

async function ask(socket, ev, data) {
  try { return await socket.timeout(20000).emitWithAck(ev, data); } catch (e) { return { error: 'the host did not answer' }; }
}

// the leader pressed Launch on a P2P group
async function launch(g) {
  const p = state(g);
  if (p.launching || g.game.gameId) return;
  if (!p.host) return g.systemChat('Nobody is hosting this group yet. The leader can open the Peer to Peer box on this page to host on their own PC.');
  const s = g.settings;
  const sent = [], skipped = [];
  for (const m of g.memberList()) {
    if (!m.p2pOk) { if (!s.isPrivate || m.team < 4) skipped.push(m); continue; }
    let team = null, spectate = false;
    if (s.isPrivate) {
      if (m.team >= 4) continue;
      team = m.team === 3 ? null : m.team; spectate = m.team === 3;
    }
    sent.push({ m, t: ticket(m.session, team, spectate) });
  }
  // a map uploaded to this group exists only on this site: send the files along
  let mapFiles = null;
  const map = String(g.modeMap || s.map || '');
  if (map.startsWith('upload/')) {
    const key = map.slice(7);
    try {
      mapFiles = { key, png: fs.readFileSync(path.join(MAPS_DIR, key + '.png')).toString('base64'), json: fs.readFileSync(path.join(MAPS_DIR, key + '.json'), 'utf8') };
    } catch (e) { /* missing upload: the host falls back to a random map */ }
  }
  p.launching = true;
  const host = p.host;
  const res = await ask(host.socket, 'launch', { groupId: g.id, settings: s, modeMap: g.modeMap, mapFiles, tickets: sent.map((x) => x.t) });
  p.launching = false;
  if (!res || res.error) return g.systemChat(`The host couldn't start the game (${(res && res.error) || 'no answer'}).`);
  if (p.host !== host || !g.nsp) return;
  for (const { m, t } of sent) m.session.pendingGame = { p2p: true, id: res.gameId, url: `${host.url}/p2p/join?t=${t.ticket}`, spectate: t.spectate };
  g.setGame(res.gameId, 'p2p');
  for (const { m } of sent) for (const so of m.sockets) so.emit('play');
  for (const m of skipped) tell(m, 'A peer-to-peer game started, but you weren\'t sent because you haven\'t agreed to play on a player\'s PC. You can agree in the orange box, or leave the group.');
  if (skipped.length) g.systemChat(`Not sent to the game (haven't agreed to peer to peer): ${skipped.map((m) => m.name).join(', ')}.`);
}

// someone joining a P2P game already in progress (Join Game button, or a reload)
async function lateTicket(g, session) {
  const host = g.p2p && g.p2p.host;
  const m = g.members.get(session.id);
  if (!host || g.game.gameServer !== 'p2p' || !m || !m.p2pOk) return null;
  const t = ticket(session, null, false);
  const res = await ask(host.socket, 'ticket', { gameId: g.game.gameId, ticket: t });
  if (!res || res.error) return null;
  return (session.pendingGame = { p2p: true, id: g.game.gameId, url: `${host.url}/p2p/join?t=${t.ticket}`, spectate: false });
}

function endGame(g) {
  const host = g.p2p && g.p2p.host;
  if (host && g.game.gameServer === 'p2p') host.socket.emit('endGame', g.game.gameId);
}

function groupGone(g) {
  if (!g.p2p) return;
  byCode.delete(g.p2p.code);
  const host = g.p2p.host;
  g.p2p.host = null;
  if (host) { host.socket.emit('rejected', 'The group closed (everyone left).'); host.socket.disconnect(); }
}

// the host must be reachable by players' browsers; tunnels can take a few seconds to come up
async function reachable(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url + '/p2p/ping', { signal: AbortSignal.timeout(5000) });
      if (r.ok && (await r.json()).tagproLocalHost) return true;
    } catch (e) { /* retry */ }
    await new Promise((ok) => setTimeout(ok, 3000));
  }
  return false;
}

function attach(io, groups) {
  io.of('/p2p-host').on('connection', async (socket) => {
    const a = socket.handshake.auth || {};
    const reject = (why) => { socket.emit('rejected', why); socket.disconnect(); };
    const g = byCode.get(String(a.code || ''));
    if (!g || !groups.has(g.id)) return reject('Unknown host code. The group may have closed; copy a fresh command from the group page.');
    const url = String(a.url || '').replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s"'<>/]+$/.test(url)) return reject('No public address for this PC.');
    if (!(await reachable(url))) return reject(`This site couldn't reach ${url}, so players couldn't either.`);
    if (socket.disconnected || !groups.has(g.id)) return;
    const old = g.p2p.host;
    if (old) { old.socket.emit('rejected', 'Another PC took over hosting this group.'); old.socket.disconnect(); }
    const leader = g.memberList().find((m) => m.leader);
    const host = { socket, url, name: String(a.name || (leader && leader.name) || 'Host').replace(/[<>]/g, '').slice(0, 24) || 'Host' };
    g.p2p.host = host;
    socket.emit('accepted', { groupName: g.settings.name, groupId: g.id, hostName: host.name });
    g.systemChat(`${host.name} is now hosting this group's games on their PC.`);
    broadcastStatus(g);
    socket.on('ended', (gameId) => { if (g.game.gameServer === 'p2p' && g.game.gameId === gameId) g.setGame(null); });
    socket.on('disconnect', () => {
      if (g.p2p.host !== host) return;
      g.p2p.host = null;
      if (g.game.gameServer === 'p2p') g.setGame(null);
      if (g.members.size) { g.systemChat(`${host.name} stopped hosting.`); broadcastStatus(g); }
    });
  });
}

module.exports = { isP2P, state, status, sendStatus, broadcastStatus, agree, serverChanged, launch, lateTicket, endGame, groupGone, attach };
