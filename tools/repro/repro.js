// repro.js - checks how exactly tagpro-local's engine reproduces a real TagPro replay.
//
// The real server sends every player's position and velocity every 15 ticks (250 ms), rounded to
// 0.01 m. For each pair of consecutive snapshots A -> B, every ball is put exactly where the replay
// says it was at A, the engine runs the ticks up to B with the recorded key presses, and the result
// is compared with the replay's B. Starting each segment from real data keeps one early mistake
// from snowballing, so each segment tests the physics on its own.
//
//   node tools/repro/repro.js <replay.ndjson.gz> [--verbose] [--json]
const fs = require('fs'), path = require('path');
const { GameRoom } = require('../../engine/game');
const C = require('../../engine/constants');
const Box2D = require('../../engine/box2d');
const { parseReplay, KEYS } = require('./replay');
const { findMapLogic, logicMismatches, observedPortals } = require('./maps');
const { settingsFor } = require('./settings');
const V = Box2D.Common.Math.b2Vec2;
const DT = 1000 / 60;
const EXACT = 0.015; // m; snapshots are rounded to 0.01 m and 0.01 m/s, so the noise floor is ~0.01 m

function buildRoom(rep, opts = {}) {
  const logic = JSON.parse(JSON.stringify(findMapLogic(rep) || {}));
  // the live map may have been edited since the Fortunate Maps upload: portal destinations the replay
  // itself shows win over the file (cooldowns are kept from the file when the portal is in it)
  const mismatch = logicMismatches(rep, logic);
  const seen = observedPortals(rep);
  logic.portals = logic.portals || {};
  let overridden = 0;
  for (const [k, d] of Object.entries(seen)) {
    const cur = logic.portals[k];
    if (!mismatch.length && cur && cur.destination) continue; // the file fits this map: trust it
    if (cur && cur.destination && cur.destination.x === d.x && cur.destination.y === d.y) continue;
    logic.portals[k] = Object.assign({ cooldown: 0 }, cur || {}, { destination: d }); overridden++;
  }
  const map = {
    tiles: rep.map.tiles.map((c) => c.slice()),
    info: rep.map.info || {},
    switches: logic.switches || {}, fields: logic.fields || {}, portals: logic.portals || {},
    spawnPoints: logic.spawnPoints || {}, marsballs: [], gravity: rep.gravity,
  };
  let now = 0;
  const settings = Object.assign({}, settingsFor(rep), opts.settings || {}, { mode: rep.gravity ? 'gravity' : 'classic' }); // the replay itself says which
  // the run may not have used the leaderboard preset: the base acceleration and top speed the server
  // sent (their most common values) say what the group really had
  const mode = (k) => { const c = {}; for (const e of rep.events) if (e.kind === 'p') for (const x of e.u) if (typeof x.delta[k] === 'number') c[x.delta[k]] = (c[x.delta[k]] || 0) + 1; const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; return top && Number(top[0]); };
  const ac = mode('ac'), ms = mode('ms');
  if (ac) settings.accel = Math.round(ac / C.PHYSICS.ACCEL * 10) / 10;
  if (ms) settings.topspeed = Math.round(ms / C.PHYSICS.MAX_SPEED * 10) / 10;
  const room = new GameRoom({ id: 'repro', map, settings, isPrivate: true, now: () => now });
  room.later = () => null;          // tile respawns etc. come from the replay itself
  room.broadcast = () => {};
  room.send = () => {};
  room.spawnPlayer = () => {};     // respawns come from the replay too
  room.end = () => {};             // a cap in a segment mustn't end the game (the replay says when it ends)
  room.state = C.STATES.ACTIVE;
  room.setNow = (t) => { now = t; };
  room.hasLogic = !!logic.switches || Object.keys(logic.portals).length > 0;
  room.logicInfo = { mismatches: mismatch.length, portalsFromReplay: overridden };
  return room;
}

function ensurePlayer(room, id, team) {
  let p = room.players[id];
  if (p) return p;
  room.nextPlayerId = id;
  p = room.newPlayer({ id: 's' + id, name: 'p' + id, auth: false }, team || 1);
  room.players[id] = p;
  return p;
}

// put a player exactly into its recorded state
function applyState(room, p, s) {
  if (s.team && s.team !== p.team) {
    p.team = s.team;
    const f = C.getPlayerCollisions(room.settings.ghostMode, s.team === 1);
    const fix = p.body.GetFixtureList(); const fd = fix.GetFilterData(); fd.categoryBits = f.categoryBits; fd.maskBits = f.maskBits; fix.SetFilterData(fd);
  }
  for (const k of ['flag', 'bomb', 'tagpro', 'jukeJuice', 'grip', 'speed', 'potatoFlag']) if (k in s) p[k] = s[k];
  if (typeof s.ms === 'number') p.ms = s.ms;
  if (typeof s.ac === 'number') p.ac = s.ac;
  for (const k of KEYS) p.keys[k] = (s[k] || 0) > 0;
  p.dead = !!s.dead;
  // pickups fire only when a ball moves onto them: count as "already on" what the ball was touching
  // one tick before A (from its recorded velocity)
  p.onPickups = new Set();
  if (!s.dead && s.rx != null) {
    const prev = { x: s.rx - (s.lx || 0) / 60, y: s.ry - (s.ly || 0) / 60 };
    for (const o of room.overlappingTiles(prev)) {
      const kind = { 5: 'boost', 14: 'boost', 15: 'boost', 6: 'powerup', 10: 'bomb' }[Math.floor(parseFloat(o.t))];
      if (kind && o.center < C.PHYSICS.BALL_RADIUS + C.TUNING.TOUCH_RADIUS[kind]) p.onPickups.add(o.x + ',' + o.y);
      const g = parseFloat(o.t), live = g === 9.1 || (g === 9.2 && p.team === 2) || (g === 9.3 && p.team === 1);
      if (live && o.edge < C.PHYSICS.BALL_RADIUS - 0.02) p.onPickups.add('g' + room.gateGroup(o.x, o.y)); // already inside a gate that pops it
    }
  }
  if (p.dead || s.rx == null) { p.body.SetActive(false); return; }
  p.body.SetActive(true);
  p.body.SetPosition(new V(s.rx, s.ry));
  p.body.SetLinearVelocity(new V(s.lx || 0, s.ly || 0));
  p.body.SetAngularVelocity(s.a || 0);
  p.body.SetAngle(s.ra || 0);
  p.body.SetAwake(true);
}

// per-player and room state that isn't in the replay but carries over between ticks
const HIDDEN = ['jumpsLeft', 'arrivedOnPortal', 'teleportTick', 'portalPending', 'wantJump', 'invincibleUntil'];
function saveHidden(room) {
  const ps = {};
  for (const id in room.players) { const p = room.players[id]; ps[id] = { touching: new Set(p.touching) }; for (const k of HIDDEN) ps[id][k] = p[k]; }
  const held = {}; for (const k in room.buttonsHeld) held[k] = new Set(room.buttonsHeld[k]);
  return { ps, held, tick: room.tick };
}
function restoreHidden(room, h) {
  for (const id in h.ps) { const p = room.players[id]; if (!p) continue; p.touching = new Set(h.ps[id].touching); for (const k of HIDDEN) p[k] = h.ps[id][k]; }
  room.buttonsHeld = {}; for (const k in h.held) room.buttonsHeld[k] = new Set(h.held[k]);
  room.tick = h.tick;
}
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const jitter = (st) => {
  if (st.rx == null) return st;
  const o = Object.assign({}, st), j = () => (rand() - 0.5) * 0.01;
  o.rx += j(); o.ry += j(); o.lx = (o.lx || 0) + j(); o.ly = (o.ly || 0) + j();
  return o;
};

function run(file, opts = {}) {
  const rep = parseReplay(file);
  if (!rep.map) return { file, error: 'no map packet' };
  const room = buildRoom(rep, opts);
  const kOff = opts.kOff ?? -0.5; // key packets land on the nearest tick (fitted: 99.7% vs 99.1% at 0)

  // anchors: packets carrying positions; a periodic snapshot is the one ~250 ms after the last
  const ev = rep.events;
  const isPos = (e) => e.kind === 'p' && e.u.some((x) => 'rx' in x.delta || 'ry' in x.delta);
  const merged = {}; // id -> state after the latest packet
  const arrived = {}; // id -> portal tile the ball came out of and hasn't left yet
  const tiles = rep.map.tiles.map((c) => c.slice());
  let i = 0;
  // the periodic snapshots (every 15 ticks) are the position packets with another one ~250 ms
  // before or after; event packets in between (boosts, pops, portals...) rarely line up like that
  const posIdx = [];
  for (let j = 0; j < ev.length; j++) if (isPos(ev[j])) posIdx.push(j);
  const snapIdx = [];
  for (let q = 0; q < posIdx.length; q++) {
    const t = ev[posIdx[q]].t;
    let partner = false;
    for (let r = q - 1; r >= 0 && t - ev[posIdx[r]].t < 270 && !partner; r--) partner = Math.abs(t - ev[posIdx[r]].t - 250) <= 12;
    for (let r = q + 1; r < posIdx.length && ev[posIdx[r]].t - t < 270 && !partner; r++) partner = Math.abs(ev[posIdx[r]].t - t - 250) <= 12;
    if (partner) {
      // packets sent in the same tick arrive with the same time: the snapshot is all of them
      let j = posIdx[q];
      while (j + 1 < ev.length && ev[j + 1].t === ev[j].t) j++;
      if (snapIdx[snapIdx.length - 1] !== j) snapIdx.push(j);
    }
  }
  const snapSet = new Set(snapIdx);

  const results = { file, map: rep.map.info && rep.map.info.name, gravity: rep.gravity, hasLogic: room.hasLogic, logicInfo: room.logicInfo, segments: 0, exact: 0, errs: [], worst: [], byTag: {} };
  let state = 0, playing = false, ended = false;
  for (let s = 0; s < snapIdx.length - 1; s++) {
    const a = snapIdx[s], b = snapIdx[s + 1];
    // bring merged state / tiles / game state up to and including packet a
    for (; i <= a; i++) absorb(ev[i]);
    if (!playing) continue;
    const tA = ev[a].t, tB = ev[b].t;
    const n = Math.round((tB - tA) / DT);
    if (n !== 15) continue;
    // set up the room from the replay at A
    const hidden = saveHidden(room);
    const setup = (jit) => {
      restoreHidden(room, hidden);
      for (let x = 0; x < tiles.length; x++) for (let y = 0; y < tiles[x].length; y++) room.tiles[x][y] = tiles[x][y];
      const alive = [];
      for (const id in merged) {
        const st = merged[id];
        if (st._quit) { const p = room.players[id]; if (p) { p.dead = true; p.body.SetActive(false); } continue; }
        const p = ensurePlayer(room, Number(id), st.team);
        applyState(room, p, jit ? jitter(st) : st);
        p.arrivedOnPortal = arrived[id] ? arrived[id].x + ',' + arrived[id].y : null;
        p.portalPending = null;
        if (!p.dead) alive.push(p);
      }
      return alive;
    };
    const alive = setup(null);
    // what happens between A and B, per player (key changes at their tick, tags for the report)
    const tags = {}; // id -> Set
    const tag = (id, t) => (tags[id] || (tags[id] = new Set())).add(t);
    const keyAt = []; // [tick, playerId, key, down]
    const skip = new Set(); // players who die, respawn or leave in between: not compared
    let anyTiles = false, anyPop = false;
    if (ev.slice(a + 1, b + 1).some((e) => e.kind === 'end')) continue;
    for (let j = a + 1; j <= b; j++) {
      const e = ev[j];
      if (e.kind === 'tiles' && j < b) anyTiles = true;
      if (e.kind === 'left') skip.add(e.id);
      if (e.kind !== 'p') continue;
      for (const x of e.u) {
        const d = x.delta;
        if ('dead' in d) { skip.add(d.id); if (d.dead) anyPop = true; }
        if (j === b) continue;
        for (const k of KEYS) if (k in d) { keyAt.push([Math.max(0, Math.min(n, Math.floor((e.t - tA) / DT + kOff))), d.id, k, d[k] > 0, k === 'up' && d[k] > 0 && room.gravity ? ('ly' in d ? d.ly : null) : undefined]); tag(d.id, 'keys'); }
        if ('flag' in d) tag(d.id, 'flag');
        if ('bomb' in d || 'tagpro' in d || 'jukeJuice' in d) tag(d.id, 'pup');
        if (d.directSet) tag(d.id, 'directSet');
        if ('ac' in d || 'ms' in d) tag(d.id, 'accel');
      }
    }
    keyAt.sort((p, q) => p[0] - q[0]);
    // tiles that come back mid-segment (boosts, bombs, powerups, portals off cooldown) appear at their
    // tick; tiles the players use up are left to the sim
    const READY = new Set(['5', '14', '15', '10', '13', '24', '25', '6.1', '6.2', '6.3', '6.4']);
    const tileAt = [];
    for (let j = a + 1; j < b; j++) if (ev[j].kind === 'tiles') for (const u of ev[j].updates) if (READY.has(String(u.v))) tileAt.push([Math.max(0, Math.min(n, Math.floor((ev[j].t - tA) / DT - 0.5))), u]);
    // run the ticks, noting what each ball touches (keys: optional per-press tick shifts)
    const simulate = (alive, keys, tagging) => {
    let ti = 0, k = 0;
    for (let tick = 0; tick < n; tick++) {
      for (; k < keys.length && keys[k][0] <= tick; k++) {
        const [, id, key, down] = keys[k];
        const p = room.players[id];
        if (!p || p.dead) continue;
        p.keys[key] = down;
        if (room.gravity && down && key === 'up') {
          p.wantJump = true; if (tagging) tag(id, 'jump');
          // how many jumps are left isn't in the replay; the packet carrying the press shows whether
          // the real ball jumped, so the count follows it (disagreements are counted, not hidden)
          const ly = keys[k][4];
          if (ly !== undefined) {
            // the real server sends the ball's position with a press that jumps; a press without one didn't
            const realJumped = ly !== null && ly - p.body.GetLinearVelocity().y < -2.5;
            const left = p.jumpsLeft === undefined ? room.jumpLimit() : p.jumpsLeft;
            if (tagging) results.jumpPresses = (results.jumpPresses || 0) + 1;
            if (realJumped !== left > 0) {
              if (tagging) { const k = realJumped ? 'jumpRefused' : 'jumpExtra'; results[k] = (results[k] || 0) + 1; results.jumpCountFixes = (results.jumpCountFixes || 0) + 1; if (opts.onJumpDisagree) opts.onJumpDisagree({ p, room, realJumped, t: tA + tick * DT }); }
              if (realJumped) p.jumpsLeft = Math.max(1, left); // a missed refill; never zero it (one misread press would cascade)
            }
          }
        }
      }
      for (; ti < tileAt.length && tileAt[ti][0] <= tick; ti++) { const u = tileAt[ti][1]; if (room.tiles[u.x]) room.tiles[u.x][u.y] = u.v; }
      room.setNow(tA + (tick + 1) * DT);
      stepPhysics(room);
      if (opts.onTick && tagging) opts.onTick({ room, tick, tA, n, alive, events: ev.slice(a + 1, b + 1) });
      if (!tagging) continue;
      for (const p of alive) {
        if (p.dead) continue;
        for (let ce = p.body.GetContactList(); ce; ce = ce.next) {
          if (!ce.contact.IsTouching()) continue;
          tag(p.id, ce.other.player ? 'ball' : ce.other.spike ? 'spike' : 'wall');
        }
        for (const o of room.overlappingTiles(p.body.GetPosition())) {
          if (o.center > 0.34) continue;
          const b0 = Math.floor(parseFloat(o.t));
          const name = { 5: 'boost', 14: 'boost', 15: 'boost', 6: 'pupTile', 8: 'button', 9: 'gate', 10: 'bomb', 11: 'teamTile', 12: 'teamTile', 13: 'portal', 24: 'portal', 25: 'portal', 22: 'well' }[b0];
          if (name) tag(p.id, name);
        }
      }
    }
    const end = {};
    for (const p of alive) { const q = p.body.GetPosition(), v = p.body.GetLinearVelocity(); end[p.id] = { x: q.x, y: q.y, vx: v.x, vy: v.y, dead: p.dead }; }
    return end;
    };
    const endMain = simulate(alive, keyAt, true);
    const afterHidden = saveHidden(room);
    // compare with B
    const fullB = {};
    for (let j = a + 1; j <= b; j++) if (ev[j].kind === 'p') for (const x of ev[j].u) fullB[x.delta.id] = x.full;
    for (const p of alive) {
      if (skip.has(p.id)) continue;
      let consistentHow = null;
      const real = Object.assign({}, merged[p.id], fullB[p.id] || {});
      if (real.dead || real.rx == null) continue;
      if (anyTiles) tag(p.id, 'tiles');
      if (anyPop) tag(p.id, 'popNearby');
      const me = endMain[p.id]; // the main run's result (reruns below move the bodies)
      if (me.dead) tag(p.id, 'simDied');
      const pos = { x: me.x, y: me.y }, vel = { x: me.vx, y: me.vy };
      const err = me.dead ? 9 : Math.hypot(pos.x - real.rx, pos.y - real.ry);
      const verr = me.dead ? 9 : Math.hypot(vel.x - real.lx, vel.y - real.ly);
      results.segments++;
      if (err < EXACT) results.exact++;
      else if (opts.consistency !== false) {
        // can any start state within the replay's rounding (and key presses within a tick of when
        // the recorder saw them) reproduce what really happened?
        const ok = (e) => e && !e.dead && Math.hypot(e.x - real.rx, e.y - real.ry) < EXACT;
        let how = null;
        for (let r = 0; r < 12 && !how; r++) {
          const shift = r >= 6;
          const keys = shift ? keyAt.map((q) => [Math.max(0, Math.min(n, q[0] + ((rand() * 3) | 0) - 1)), q[1], q[2], q[3], q[4]]).sort((x, y) => x[0] - y[0]) : keyAt;
          const e2 = simulate(setup(true), keys, false)[p.id];
          if (ok(e2)) how = shift ? 'keyTiming' : 'rounding';
        }
        restoreHidden(room, afterHidden);
        if (how) { results.consistent = results.consistent || {}; results.consistent[how] = (results.consistent[how] || 0) + 1; }
        consistentHow = how;
      }
      results.errs.push(err);
      const tg = [...(tags[p.id] || [])].sort().join('+') || 'free';
      const bt = results.byTag[tg] || (results.byTag[tg] = { n: 0, exact: 0, sumErr: 0 });
      bt.n++; if (err < EXACT) bt.exact++; else if (consistentHow) bt.consistent = (bt.consistent || 0) + 1; bt.sumErr += Math.min(err, 2);
      if (opts.verbose && err >= EXACT && !(opts.bad && consistentHow)) console.log(`t=${tA} id=${p.id} n=${n} err=${err.toFixed(3)} verr=${verr.toFixed(2)} tag=${tg} sim=(${pos.x.toFixed(3)},${pos.y.toFixed(3)} v ${vel.x.toFixed(2)},${vel.y.toFixed(2)}) real=(${real.rx},${real.ry} v ${real.lx},${real.ly}) start=(${merged[p.id].rx},${merged[p.id].ry} v ${merged[p.id].lx},${merged[p.id].ly}) keys=${keyAt.filter((q) => q[1] === p.id).map((q) => q[0] + q[2][0] + (q[3] ? '+' : '-')).join(',')}`);
      results.worst.push({ t: tA, id: p.id, err, verr, tag: tg });
      if (opts.dump) opts.dump.push({ consistent: err < EXACT || !!consistentHow, simDied: me.dead, tag: tg, dx: me.dead ? 9 : pos.x - real.rx, dy: me.dead ? 0 : pos.y - real.ry, dvx: vel.x - real.lx, dvy: vel.y - real.ly, vx: real.lx, vy: real.ly, ax: real.lx - merged[p.id].lx, ay: real.ly - merged[p.id].ly });
    }
  }
  results.worst.sort((p, q) => q.err - p.err);
  results.worst = results.worst.slice(0, 10);
  const e = results.errs.sort((p, q) => p - q);
  results.median = e.length ? e[e.length >> 1] : null;
  results.p95 = e.length ? e[Math.floor(e.length * 0.95)] : null;
  delete results.errs;
  results.pct = results.segments ? results.exact / results.segments : null;
  const cons = results.consistent || {};
  results.pctConsistent = results.segments ? (results.exact + (cons.rounding || 0) + (cons.keyTiming || 0)) / results.segments : null;
  return results;

  function absorb(e) {
    if (e.kind === 'time') { playing = [1, 5, 7].includes(e.state); return; }
    if (e.kind === 'end') { playing = false; ended = true; return; }
    if (e.kind === 'tiles') { for (const u of e.updates) if (tiles[u.x]) tiles[u.x][u.y] = u.v; return; }
    if (e.kind === 'left') { if (merged[e.id]) merged[e.id]._quit = true; return; }
    if (e.kind === 'p') for (const x of e.u) {
      merged[x.delta.id] = Object.assign(merged[x.delta.id] || {}, x.full);
      // a ball the server snapped onto a portal tile arrived through it; it re-arms once the ball rolls off
      const f = x.full, d = x.delta;
      if (d.directSet && f.rx != null) {
        const tx = Math.round(f.rx / 0.4), ty = Math.round(f.ry / 0.4), t = rep.map.tiles[tx] && rep.map.tiles[tx][ty];
        if ([13, 24, 25].includes(Math.floor(parseFloat(t)))) arrived[d.id] = { x: tx, y: ty };
      } else if (arrived[d.id] && f.rx != null && Math.hypot(f.rx - arrived[d.id].x * 0.4, f.ry - arrived[d.id].y * 0.4) > C.PHYSICS.BALL_RADIUS + C.TUNING.TOUCH_RADIUS.portal) delete arrived[d.id];
      if (f.dead) delete arrived[d.id];
    }
  }
}

// one server tick: the movement + world step + tile/contact logic from GameRoom.step, minus the
// clock, packets and AFK handling
function stepPhysics(room) {
  room.tick++;
  const saved = room.flushDirty; room.flushDirty = () => {}; room.dirty = null;
  const updateClock = room.updateClock; room.updateClock = () => {};
  const afk = room.afkCheck; room.afkCheck = () => {};
  const sec = room.secondTick; room.secondTick = () => {};
  const snap = room.snapshot; room.snapshot = () => {};
  room.step();
  room.flushDirty = saved; room.updateClock = updateClock; room.afkCheck = afk; room.secondTick = sec; room.snapshot = snap;
}

module.exports = { run, buildRoom, stepPhysics };

if (require.main === module) {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  const opt = { verbose: args.includes('--verbose') || args.includes('--bad'), bad: args.includes('--bad') };
  const ko = args.find((a) => a.startsWith('--kOff=')); if (ko) opt.kOff = Number(ko.split('=')[1]);
  for (const f of files) {
    const r = run(f, opt);
    if (args.includes('--json')) console.log(JSON.stringify(r));
    else console.log(r.error ? `${f}: ${r.error}` : `${path.basename(f)} ${r.map} grav=${r.gravity} logic=${r.hasLogic} segs=${r.segments} exact=${(100 * r.pct).toFixed(1)}% median=${r.median && r.median.toFixed(4)} p95=${r.p95 && r.p95.toFixed(3)}\n  ${Object.entries(r.byTag).sort((a, b) => b[1].n - a[1].n).slice(0, 12).map(([k, v]) => `${k}: ${v.n} ${(100 * v.exact / v.n).toFixed(0)}% avg ${(v.sumErr / v.n).toFixed(3)}`).join('\n  ')}`);
  }
}
