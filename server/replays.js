// replays.js - records every game in the real replay format (NDJSON lines of [ms, event, data],
// first line "recorder-metadata"), stores them in data/replays, and serves the real Replays page
// API: /replays/data (listing/filters) and /replays/gameFile (download / viewer).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'data', 'replays');
const INDEX = path.join(DIR, 'index.json');
const MAX_REPLAYS = 1000;
fs.mkdirSync(DIR, { recursive: true });

let index = [];
try { index = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch (e) { index = []; }
function saveIndex() {
  fs.writeFileSync(INDEX + '.tmp', JSON.stringify(index));
  fs.renameSync(INDEX + '.tmp', INDEX);
}

const hexId = () => crypto.randomBytes(12).toString('hex'); // 24 hex chars, like the real game ids

// key used in /game?replay=<key>: base64(gameIdHex + userIdHex) with "+" -> "_" (client's hexToBase64)
function keyToGameId(key) {
  try {
    const b64 = String(key).slice(0, 16).replace(/_/g, '+');
    const hex = Buffer.from(b64, 'base64').toString('hex');
    return /^[0-9a-f]{24}$/.test(hex) ? hex : null;
  } catch (e) { return null; }
}

// A pseudo-client the GameRoom treats as a silent spectator; it buffers every packet.
class Recorder {
  constructor(room) {
    this.id = hexId();
    this.room = room;
    this.t0 = Date.now();
    this.lines = [];
    this.started = new Date();
    this.closed = false;
  }
  emit(ev, data) {
    if (this.closed) return;
    this.lines.push(JSON.stringify([Date.now() - this.t0, ev, data === undefined ? null : data]));
  }
  disconnect() { this.finish(); }

  finish() {
    if (this.closed) return;
    this.closed = true;
    const r = this.room;
    if (!this.lines.some((l) => l.includes('"time"'))) return; // nothing playable recorded
    const players = Object.values(r.playerHistory || {}).map((p) => ({ ...p, joined: new Date(p.joined).toISOString(), left: p.left ? new Date(p.left).toISOString() : null }));
    const winner = r.winner === 'red' ? 1 : r.winner === 'blue' ? 2 : 0;
    const meta = {
      uuid: r.uuid, started: this.t0, duration: Date.now() - this.t0, finished: !!r.ended,
      mapName: r.mapName, mapType: 'ctf', serverName: 'Local', gameId: r.id, gameMode: 'normal',
      private: !!r.isPrivate, maptest: !!r.settings.mapTestingMode, ranked: false, minigame: false, voided: false,
      teams: { red: { name: r.settings.redTeamName, score: r.score.r }, blue: { name: r.settings.blueTeamName, score: r.score.b } },
      winner, players: players.map(({ id, team, userId, displayName, joined, left, finished }) => ({ id, team, userId, displayName, joined: Date.parse(joined), left: left ? Date.parse(left) : null, finished })),
    };
    const file = path.join(DIR, this.id + '.ndjson');
    fs.writeFileSync(file, [JSON.stringify([0, 'recorder-metadata', meta]), JSON.stringify([0, 'connect', null])].concat(this.lines).join('\n') + '\n');
    index.unshift({
      id: this.id, uuid: r.uuid, started: this.started.toISOString(),
      visibility: r.settings.mapTestingMode ? 'Maptest' : r.isPrivate ? 'Private' : 'Casual',
      mapName: r.mapName, mapType: 'CTF', server: 'Local', duration: meta.duration, winner,
      teams: meta.teams, players, groupId: r.groupId || null,
    });
    while (index.length > MAX_REPLAYS) {
      const old = index.pop();
      try { fs.unlinkSync(path.join(DIR, old.id + '.ndjson')); } catch (e) { /* gone */ }
    }
    saveIndex();
    this.lines = null;
  }
}

// /replays/data: same response shape as the real site
function list(query, viewerUserId) {
  const page = Math.max(0, parseInt(query.page, 10) || 0);
  const pageSize = Math.min(50, Math.max(1, parseInt(query.pageSize, 10) || 25));
  const forUser = query.userId || null;
  let rows = index;
  if (forUser) rows = rows.filter((g) => g.players.some((p) => p.userId === forUser));
  if (query.mapName) rows = rows.filter((g) => g.mapName.toLowerCase().includes(String(query.mapName).toLowerCase()));
  if (query.visibility) rows = rows.filter((g) => g.visibility === query.visibility);
  if (query.dateStart) rows = rows.filter((g) => Date.parse(g.started) >= Number(query.dateStart));
  if (query.dateEnd) rows = rows.filter((g) => Date.parse(g.started) < Number(query.dateEnd));
  const me = forUser || viewerUserId;
  const games = rows.slice(page * pageSize, page * pageSize + pageSize).map((g) => {
    const mine = me && g.players.find((p) => p.userId === me);
    const myTeam = mine ? (mine.team === 1 ? 'red' : 'blue') : null;
    return {
      id: g.id, uuid: g.uuid, started: g.started, visibility: g.visibility, mapName: g.mapName, mapType: g.mapType,
      favorite: null, server: g.server, duration: g.duration,
      myTeam, myTeamName: myTeam ? g.teams[myTeam].name : null, myTeamWon: !!mine && g.winner === mine.team,
      winner: g.winner, teams: g.teams, players: g.players, gameUser: forUser || null,
    };
  });
  return { games, userId: forUser, name: null, reservedName: null };
}

function file(id) {
  if (!/^[0-9a-f]{24}$/.test(id || '')) return null;
  const g = index.find((x) => x.id === id);
  const f = path.join(DIR, id + '.ndjson');
  if (!g || !fs.existsSync(f)) return null;
  return { path: f, name: `${g.mapName} - ${new Date(g.started).toISOString().slice(0, 16).replace('T', ' ')}` };
}

module.exports = { Recorder, list, file, keyToGameId, hexId };
