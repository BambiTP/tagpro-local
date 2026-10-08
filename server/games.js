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
const ranked = require('./ranked');

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

// a map image's size from its PNG header, checked before decoding (a 2 MB file can decode to gigabytes)
const MAX_MAP_TILES = 256; // real maps are well under 100 x 100
function checkPngSize(buf) {
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') throw new MapError('That map image is not a PNG.');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w > MAX_MAP_TILES || h > MAX_MAP_TILES) throw new MapError(`That map is ${w} x ${h} tiles; the most is ${MAX_MAP_TILES} x ${MAX_MAP_TILES}.`);
}

function readMap(key) {
  const file = fs.readFileSync(path.join(MAPS_DIR, key + '.png'));
  checkPngSize(file);
  const png = PNG.sync.read(trimPng(file));
  const json = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, key + '.json'), 'utf8'));
  return loadMap(png, json);
}

// Fortunate Maps ids are numbers. Anything else could point the saved file outside maps/ (and the
// site answers unknown ids with a page, not an error), so it is refused outright.
async function fetchFortunateMap(id) {
  id = String(id);
  if (!/^\d{1,9}$/.test(id)) throw new Error('not a Fortunate Maps id: ' + id.slice(0, 40));
  if (fs.existsSync(path.join(MAPS_DIR, id + '.png'))) return id;
  const files = {};
  for (const ext of ['png', 'json']) {
    const r = await fetch(`https://fortunatemaps.herokuapp.com/${ext}/${id}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('map ' + id + ' not found');
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > 2 * 1024 * 1024) throw new Error('map ' + id + ' is too big');
    if (ext === 'png') checkPngSize(body); // also rejects the page it sends for ids that don't exist
    else JSON.parse(body.toString('utf8'));
    files[ext] = body;
  }
  for (const ext of ['json', 'png']) fs.writeFileSync(path.join(MAPS_DIR, `${id}.${ext}`), files[ext]); // .png last: it marks the map installed
  return id;
}

// a team with no spawn points and no flag has nowhere to spawn: such a map can't be played
// (eggball spawns players its own way)
class MapError extends Error {}
function checkSpawns(room) {
  if (!room.egg && [1, 2].some((t) => !room.spawnTiles[t].length)) throw new MapError(`The map "${room.mapName}" has no valid spawns, so it can't be played.`);
}
// the error message if map `key` can't be played, else null (for uploads and the admin panel)
function mapProblem(key, settings = {}) {
  try {
    const map = readMap(key);
    checkSpawns(new GameRoom({ id: 'check', uuid: 'check', map, mapName: map.info.name, settings: { ...settings }, isPrivate: true, onEnd() {}, onEmpty() {} }));
    return null;
  } catch (e) { return e instanceof MapError ? e.message : `The map ${key} couldn't be read.`; }
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
// onFinish: called once when the game ends or empties (a peer-to-peer host tells the main site)
function createGame({ mapKey, settings, isPrivate, groupId, onFinish }) {
  const map = readMap(mapKey);
  const id = gameId();
  let finished = false;
  const finish = () => { if (!finished && onFinish) { finished = true; onFinish(id); } };
  const room = new GameRoom({
    id, uuid: crypto.randomUUID(), map, mapName: map.info.name, settings, isPrivate, groupId,
    onEnd: (r, winner) => {
      setTimeout(() => r.recorder && r.recorder.finish(), 3000); // replay saved shortly after the end
      if (r.countsForStats) recordStats(r, winner);
      if (r.ranked) ranked.finish(r, winner);
      const g = groupId && groups.groups.get(groupId);
      if (g && g.game.gameId === id) g.setGame(null);
      finish();
    },
    onEmpty: (r) => {
      if (r.closed || r.ended) { games.delete(id); const g = groupId && groups.groups.get(groupId); if (g && g.game.gameId === id) g.setGame(null); finish(); }
    },
  });
  checkSpawns(room); // before anything starts or is recorded
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
  let room;
  try { room = createGame({ mapKey, settings: s, isPrivate: s.isPrivate, groupId: group.id }); } catch (e) {
    if (!(e instanceof MapError)) throw e;
    return group.systemChat(e.message + ' Pick another map.');
  }
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
      // peer-to-peer group: the game is on a player's PC
      if (g && g.game.gameServer === 'p2p') {
        sent = true;
        const mem = g.members.get(session.publicId);
        if (!mem || !mem.p2pOk) return socket.emit('SendToPage', { url: '/groups/' + g.id, reason: "You haven't agreed to play this group's peer-to-peer games" });
        if (!pg || !pg.p2p || pg.id !== g.game.gameId) pg = await require('./p2p').lateTicket(g, session);
        if (!pg) return socket.emit('SendToPage', { url: '/groups/' + g.id, reason: 'No game running for your group' });
        return setTimeout(() => socket.emit('FoundWorld', { url: pg.url, spectate: pg.spectate || null }), 500);
      }
      if (!pg || pg.p2p || !games.has(pg.id) || games.get(pg.id).ended) {
        if (g && g.game.gameId && games.has(g.game.gameId)) pg = session.pendingGame = { id: g.game.gameId, team: null, spectate: false };
        else if (!g) { sent = true; socket.emit('serverStatsUpdated', queue.statsPacket()); return (session.joinType === 'ranked' ? ranked : queue).join(session, socket); }
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
ranked.init({ createGame, resolveMap, games });

module.exports = { games, MapError, mapProblem, checkPngSize, createGame, launchGroupGame, endGame, attachJoiner, attachGames, resolveMap, fetchFortunateMap, mapKeys };
