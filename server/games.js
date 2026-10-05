// games.js - creates/tracks game rooms, map selection, and the joiner (/games/find).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PNG } = require('pngjs');
const { loadMap, trimPng } = require('../engine/mapLoader');
const { GameRoom } = require('../engine/game');
const sessions = require('./sessions');
const groups = require('./groups');
const replays = require('./replays');
const queue = require('./queue');

const MAPS_DIR = path.join(__dirname, '..', 'maps');
const games = new Map();

function gameId() {
  let s;
  do { s = Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join(''); } while (games.has(s));
  return s;
}

// ---- maps: maps/<key>.png + maps/<key>.json ; key is a Fortunate Maps id or a name ----
function mapKeys() {
  return fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4))
    .filter((k) => fs.existsSync(path.join(MAPS_DIR, k + '.json')));
}

function readMap(key) {
  const png = PNG.sync.read(trimPng(fs.readFileSync(path.join(MAPS_DIR, key + '.png'))));
  const json = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, key + '.json'), 'utf8'));
  return loadMap(png, json);
}

async function fetchFortunateMap(id) {
  if (fs.existsSync(path.join(MAPS_DIR, id + '.png'))) return id;
  for (const ext of ['png', 'json']) {
    const r = await fetch(`https://fortunatemaps.herokuapp.com/${ext}/${id}`);
    if (!r.ok) throw new Error('map ' + id + ' not found');
    fs.writeFileSync(path.join(MAPS_DIR, `${id}.${ext}`), Buffer.from(await r.arrayBuffer()));
  }
  return String(id);
}

function rotationKeys() {
  const f = path.join(MAPS_DIR, 'rotation.json');
  const list = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  const all = mapKeys().filter((k) => !k.startsWith('upload-'));
  const keys = list ? list.map(String).filter((k) => all.includes(k)) : all;
  return keys.length ? keys : all;
}

async function resolveMap(setting, pool) {
  const v = String(setting || 'random');
  if (v.startsWith('fm_id/')) return fetchFortunateMap(v.slice(6));
  if (v.startsWith('upload/') && mapKeys().includes(v.slice(7))) return v.slice(7);
  const all = mapKeys();
  // a named map from the group dropdown, if we have it locally (by file key or info.name)
  if (!v.startsWith('random')) {
    if (all.includes(v)) return v;
    for (const k of all) {
      try { const j = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, k + '.json'), 'utf8')); if (j.info && j.info.name === v) return k; } catch (e) { /* skip */ }
    }
  }
  const keys = (pool && pool.filter((k) => all.includes(k))) || rotationKeys();
  const list = keys.length ? keys : rotationKeys();
  return list[Math.floor(Math.random() * list.length)];
}

// ---- public game stats (Play Now games only) ----
function recordStats(room, winner) {
  const accounts = require('./accounts');
  for (const p of Object.values(room.players)) {
    if (!p.accountId) continue;
    const res = accounts.recordGame(p.accountId, {
      won: (winner === 'red' && p.team === 1) || (winner === 'blue' && p.team === 2), tied: winner === 'tie',
      timePlayed: room.now() - p.joinedAt, score: p.score,
      tags: p['s-tags'], pops: p['s-pops'], grabs: p['s-grabs'], drops: p['s-drops'], hold: p['s-hold'],
      captures: p['s-captures'], prevent: p['s-prevent'], returns: p['s-returns'], support: p['s-support'], powerups: p['s-powerups'],
    });
    if (res && res.degreeUp) {
      p.degree = res.degree; room.queue(p, 'degree');
      room.send(p.client, 'sound', { s: 'degreeup', v: 1 });
    }
  }
}

// ---- rooms ----
function createGame({ mapKey, settings, isPrivate, groupId }) {
  const map = readMap(mapKey);
  const id = gameId();
  const room = new GameRoom({
    id, uuid: crypto.randomUUID(), map, mapName: map.info.name, settings, isPrivate, groupId,
    onEnd: (r, winner) => {
      setTimeout(() => r.recorder && r.recorder.finish(), 3000); // replay saved shortly after the end
      if (r.countsForStats) recordStats(r, winner);
      const g = groupId && groups.groups.get(groupId);
      if (g && g.game.gameId === id) g.setGame(null);
    },
    onEmpty: (r) => {
      if (r.closed || r.ended) { games.delete(id); const g = groupId && groups.groups.get(groupId); if (g && g.game.gameId === id) g.setGame(null); }
    },
  });
  room.onMapRating = (session, mapName, value) => require('./mapstats').rate(session, mapName, value);
  games.set(id, room);
  room.recorder = new replays.Recorder(room);
  room.addRecorder(room.recorder); // every game gets a replay
  room.start();
  console.log(`game ${id} on ${map.info.name}${groupId ? ' for group ' + groupId : ''}`);
  return room;
}

async function launchGroupGame(group) {
  if (group.game.gameId && games.has(group.game.gameId) && !games.get(group.game.gameId).ended) return;
  const s = group.settings;
  // eggball / ice hockey play on their own map (group.modeMap) unless a map was picked after the mode
  const mapKey = await resolveMap(group.modeMap || s.map).catch(() => resolveMap('random'));
  const room = createGame({ mapKey, settings: s, isPrivate: s.isPrivate, groupId: group.id });
  for (const m of group.memberList()) {
    if (s.isPrivate) {
      if (m.team >= 4) continue;
      m.session.pendingGame = { id: room.id, team: m.team === 3 ? null : m.team, spectate: m.team === 3 };
    } else {
      m.session.pendingGame = { id: room.id, team: null, spectate: false };
    }
  }
  group.setGame(room.id);
  group.nsp.emit('play');
}

function endGame(id) {
  const r = games.get(id);
  if (r && !r.ended) r.end(r.score.r > r.score.b ? 'red' : r.score.b > r.score.r ? 'blue' : 'tie', false);
}

// ---- joiner: /games/find ----
function attachJoiner(io) {
  io.of('/games/find').on('connection', async (socket) => {
    const session = sessions.fromSocket(socket);
    if (!session) return socket.disconnect();
    socket.emit('ServerList', [{ id: 'local', host: socket.handshake.headers.host, regions: ['US East'], coords: '0,0', name: 'Local', rankedRegion: 'na', ranked: false }]);
    socket.emit('ready');
    const g = session.groupId && groups.groups.get(session.groupId);
    if (g) socket.emit('JoinerSettings', { regions: g.settings.regions, gameModes: ['classic'], spectate: false }, true);
    else socket.emit('JoinerSettings', { regions: ['US East', 'US Central', 'US West', 'Europe', 'Oceanic'], gameModes: ['classic'], spectate: false }, false);
    let sent = false;
    const go = async () => {
      if (sent) return;
      let pg = session.pendingGame;
      if (!pg || !games.has(pg.id) || games.get(pg.id).ended) {
        if (g && g.game.gameId && games.has(g.game.gameId)) pg = session.pendingGame = { id: g.game.gameId, team: null, spectate: false };
        else if (!g) { sent = true; socket.emit('serverStatsUpdated', queue.statsPacket()); return queue.join(session, socket); }
        else return socket.emit('SendToPage', { url: '/groups/' + g.id, reason: 'No game running for your group' });
      }
      sent = true;
      setTimeout(() => socket.emit('FoundWorld', { url: '/game', spectate: pg.spectate || null }), 500);
    };
    socket.on('JoinerSelections', go);
    socket.on('leaveJoiner', () => socket.disconnect());
  });
}

// ---- game sockets: /game/<id> ----
function attachGames(io) {
  io.of(/^\/game\/[a-z]{8}$/).on('connection', (socket) => {
    const room = games.get(socket.nsp.name.slice(6));
    const session = sessions.fromSocket(socket);
    if (!room || !session || room.ended) { socket.emit('disconnectReason', 'ended'); return socket.disconnect(); }
    const pg = session.pendingGame && session.pendingGame.id === room.id ? session.pendingGame : { team: null, spectate: true };
    const client = { emit: (ev, d) => socket.emit(ev, d), disconnect: () => socket.disconnect(true) };
    room.addClient(client, session, { team: pg.team, spectate: pg.spectate });
    socket.onAny((ev, d) => client.onEvent && client.onEvent(ev, d));
    socket.on('disconnect', () => room.removeClient(client));
  });
}

queue.init({ createGame, resolveMap, games });

module.exports = { games, createGame, launchGroupGame, endGame, attachJoiner, attachGames, resolveMap, fetchFortunateMap, mapKeys };
