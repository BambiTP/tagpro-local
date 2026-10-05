// replay.js - reads a real TagPro replay (.ndjson or .ndjson.gz) into what the repro harness needs:
// the map, each player's state over time, every key change, tile updates and the server snapshots.
//
// Player fields in "p" packets are delta-compressed (a field is only sent when it changes), so the
// full state of every player is rebuilt packet by packet.
const fs = require('fs'), zlib = require('zlib'), path = require('path');

const KEYS = ['up', 'down', 'left', 'right'];

function readPackets(file) {
  let buf = fs.readFileSync(file);
  if (file.endsWith('.gz')) buf = zlib.gunzipSync(buf);
  const out = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) { /* truncated last line */ }
  }
  return out;
}

// Returns { meta, clientInfo, map, gravity, events } where events is a time-ordered list of
//   { t, kind: 'p', u: [player deltas] }   (each delta also gets .full = merged player state after it)
//   { t, kind: 'tiles', updates: [{x, y, v}] }
//   { t, kind: 'time', state }
function parseReplay(file) {
  const packets = readPackets(file);
  const r = { file, meta: null, clientInfo: null, map: null, events: [], players: {}, groupId: null };
  const state = {}; // id -> merged player state
  for (const pk of packets) {
    const [t, ev, d] = pk;
    if (ev === 'recorder-metadata') r.meta = d;
    else if (ev === 'clientInfo') r.clientInfo = d;
    else if (ev === 'map') r.map = d;
    else if (ev === 'groupId') r.groupId = d;
    else if (ev === 'time') r.events.push({ t, kind: 'time', state: d.state, time: d.time });
    else if (ev === 'mapupdate') r.events.push({ t, kind: 'tiles', updates: Array.isArray(d) ? d : [d] });
    else if (ev === 'bomb') r.events.push({ t, kind: 'bomb', x: d.x / 100, y: d.y / 100, type: d.type });
    else if (ev === 'splat') r.events.push({ t, kind: 'splat', x: d.x / 100, y: d.y / 100, team: d.t });
    else if (ev === 'end') r.events.push({ t, kind: 'end' });
    else if (ev === 'playerLeft') r.events.push({ t, kind: 'left', id: d });
    else if (ev === 'p') {
      const u = Array.isArray(d) ? d : d.u;
      const list = [];
      for (const o of u) {
        const s = state[o.id] || (state[o.id] = { id: o.id });
        Object.assign(s, o);
        list.push({ delta: o, full: Object.assign({}, s) });
      }
      r.events.push({ t, kind: 'p', u: list });
    }
  }
  r.players = state;
  // the gravity script in clientInfo is what the game ran with; the recorder's gameMode can disagree
  r.gravity = r.clientInfo ? (r.clientInfo.eventScripts || []).some((s) => /gravity/.test(s)) : !!(r.meta && r.meta.gameMode === 'gravity');
  return r;
}

module.exports = { readPackets, parseReplay, KEYS };
