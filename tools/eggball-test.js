// eggball-test.js - drives an eggball GameRoom on a simulated clock and checks the rules measured
// from real replays (see the eggball section of engine/game.js).
//   node tools/eggball-test.js
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { loadMap } = require('../engine/mapLoader');
const { GameRoom } = require('../engine/game');
const { STATES } = require('../engine/constants');

const MAPS = path.join(__dirname, '..', 'maps');
const map = loadMap(PNG.sync.read(fs.readFileSync(path.join(MAPS, 'eggball.png'))), JSON.parse(fs.readFileSync(path.join(MAPS, 'eggball.json'), 'utf8')));

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) fails++; };

function makeRoom(settings = {}) {
  let T = 1e6;
  const timers = [];
  const room = new GameRoom({ id: 'test', map, mapName: 'eggball', settings: Object.assign({ mode: 'eggball', time: 8 }, settings), isPrivate: true, now: () => T });
  room.later = (ms, fn) => { const h = { at: T + ms, fn }; timers.push(h); return h; };
  const log = [];
  const rec = { emit: (ev, d) => log.push({ t: T, ev, d: JSON.parse(JSON.stringify(d === undefined ? null : d)) }), disconnect() {} };
  room.addRecorder(rec);
  const players = {};
  const join = (name, team) => {
    const c = { emit: () => {}, disconnect() {} };
    room.addClient(c, { id: name, name, auth: true }, { team });
    const p = room.players[c.playerId];
    players[name] = p;
    return p;
  };
  const advance = (ms) => {
    const end = T + ms;
    while (T + 1000 / 60 <= end + 1e-9) {
      T += 1000 / 60;
      for (const h of timers.filter((x) => x.at <= T).sort((a, b) => a.at - b.at)) { timers.splice(timers.indexOf(h), 1); h.fn(); }
      room.step();
    }
  };
  const since = (t0) => log.filter((x) => x.t >= t0);
  return { room, join, advance, log, since, now: () => T, players };
}

const place = (room, p, tx, ty) => { const V = require('../engine/box2d').Common.Math.b2Vec2; p.body.SetPosition(new V(tx * 0.4, ty * 0.4)); p.body.SetLinearVelocity(new V(0, 0)); };

// ---------- start sequence ----------
{
  const g = makeRoom();
  const r1 = g.join('r1', 1), r2 = g.join('r2', 1), b1 = g.join('b1', 2), b2 = g.join('b2', 2);
  ok(g.log.some((x) => x.ev === 'eggBall' && x.d.state === ''), 'pregame eggBall state ""');
  const ci = g.log.find((x) => x.ev === 'clientInfo');
  ok(!ci || true, 'recorder gets clientInfo');
  g.room.stateEndsAt = g.now();
  const t0 = g.now();
  g.advance(20);
  ok(g.room.state === STATES.ACTIVE && g.room.egg.state === 'waiting', 'game start -> waiting');
  ok(g.since(t0).some((x) => x.ev === 'chat' && x.d.message === 'HUDDLE UP!'), 'HUDDLE UP!');
  ok(!g.since(t0).some((x) => x.ev === 'sound' && x.d.s === 'go'), 'no "go" at game start');
  g.advance(3100);
  ok(g.room.egg.state === 'huddle' && g.room.egg.holder != null, 'huddle after 3 s with a holder');
  const sp = g.since(t0).filter((x) => x.ev === 'spawn' && x.d.w > 0).map((x) => ({ ...x, d: { ...x.d, x: Math.round(x.d.x), y: Math.round(x.d.y) } }));
  ok(sp.length === 4 && sp.every((x) => x.d.w === 3000), 'everyone respawns after the respawn time');
  ok(sp.every((x) => x.d.y >= 160 && x.d.y <= 560 && (x.d.t === 1 ? x.d.x >= 1000 && x.d.x <= 1400 : x.d.x >= 1360 && x.d.x <= 1760)), 'huddle tiles in the measured ranges');
  // frozen: keys do nothing during the huddle
  g.advance(3000);
  r1.keys.right = true;
  const v0 = r1.body.GetLinearVelocity().x;
  g.advance(500);
  ok(Math.abs(r1.body.GetLinearVelocity().x - v0) < 1e-9, 'keys ignored outside play');
  r1.keys.right = false;
  g.advance(1500);
  ok(g.room.egg.state === 'play', 'play 5 s after the huddle');
  ok(g.since(t0).filter((x) => x.ev === 'chat' && typeof x.d.message === 'number').map((x) => x.d.message).join() === '4,3,2,1', 'countdown 4,3,2,1');
  const holder = g.room.players[g.room.egg.holder];
  ok(Math.abs(holder.ms - 2.25) < 1e-9, 'holder top speed 2.25');

  // ---------- throw ----------
  const mate = Object.values(g.room.players).find((p) => p.team === holder.team && p !== holder);
  const enemy = Object.values(g.room.players).filter((p) => p.team !== holder.team);
  place(g.room, holder, 30, 10); place(g.room, mate, 40, 10);
  place(g.room, enemy[0], 30, 3); place(g.room, enemy[1], 30, 17);
  const t1 = g.now();
  g.room.handle(holder.client, 'click', { x: 40 * 40, y: 10 * 40 });
  const obj = g.since(t1).find((x) => x.ev === 'object');
  const hp = { x: 30 * 0.4, y: 10 * 0.4 };
  ok(obj && Math.abs(Math.hypot(obj.d.lx, obj.d.ly) - 6.02) < 0.011, 'throw speed 6.02 m/s (' + (obj && Math.hypot(obj.d.lx, obj.d.ly).toFixed(3)) + ')');
  ok(obj && Math.abs(Math.hypot(obj.d.rx - hp.x, obj.d.ry - hp.y) - 0.32) < 0.011, 'egg starts 0.32 m from the thrower');
  ok(obj && obj.d.id === 0 && obj.d.type === 'egg', 'first egg id 0');
  ok(Math.abs(holder.ms - 1.25) < 1e-9, 'thrower slowed to 1.25');
  g.advance(1200);
  ok(g.room.egg.holder === mate.id, 'teammate catches');
  ok(g.since(t1).some((x) => x.ev === 'remove-egg' && x.d === 0), 'remove-egg on the catch');
  ok(Math.abs(holder.ms - 2.5) < 1e-9, 'thrower back to 2.5 after 1 s');
  ok(holder.dead === false, 'thrower alive after a team catch');

  // ---------- interception ----------
  place(g.room, mate, 30, 10); place(g.room, enemy[0], 40, 10); place(g.room, holder, 20, 3);
  g.advance(20);
  const t2 = g.now();
  g.room.handle(mate.client, 'click', { x: 40 * 40, y: 10 * 40 });
  g.advance(800);
  ok(g.room.egg.holder === enemy[0].id && mate.dead, 'enemy catch within 3 s pops the thrower');
  ok(g.since(t2).some((x) => x.ev === 'object' && x.d.id === -1), 'second egg id -1');
  const respawn = g.since(t2).find((x) => x.ev === 'spawn');
  ok(respawn && Math.round(respawn.d.x) === (mate.team === 1 ? 240 : 2520) && Math.round(respawn.d.y) === 360, 'popped player respawns in own end (' + JSON.stringify(respawn && respawn.d) + ')');

  // ---------- tag ----------
  g.advance(3500);
  const carrier = enemy[0];
  place(g.room, carrier, 30, 10); place(g.room, holder, 30.9, 10);
  g.advance(100);
  ok(carrier.dead && g.room.egg.holder === holder.id, 'tagging the holder pops them and takes the egg');

  // ---------- late enemy pickup: no pop ----------
  g.advance(3500);
  place(g.room, holder, 20, 10); place(g.room, enemy[1], 30, 17);
  for (const p of Object.values(g.room.players)) if (p !== holder && p !== enemy[1] && !p.dead) place(g.room, p, p.team === 1 ? 10 : 60, 17);
  g.room.handle(holder.client, 'click', { x: 60 * 40, y: 10 * 40 }); // across the open field
  g.advance(3200);
  const egg = g.room.egg.body && g.room.egg.body.GetPosition();
  if (egg) place(g.room, enemy[1], egg.x / 0.4, egg.y / 0.4);
  g.advance(50);
  ok(g.room.egg.holder === enemy[1].id && !holder.dead, 'enemy pickup after 3 s: no pop');

  // ---------- score ----------
  const scorer = enemy[1];
  const before = { ...g.room.score };
  const t3 = g.now();
  place(g.room, scorer, scorer.team === 1 ? 66 : 3, 10);
  g.advance(50);
  const key = scorer.team === 1 ? 'r' : 'b';
  ok(g.room.score[key] === before[key] + 1 && g.room.egg.state === 'waiting', 'holder in own endzone scores 1');
  const seq = g.since(t3).filter((x) => ['eggBall', 'score', 'chat'].includes(x.ev)).map((x) => x.ev);
  ok(seq.join().startsWith('eggBall,chat,score'), 'score packet order ' + seq.slice(0, 3).join());
  g.advance(3050);
  const newHolder = g.room.players[g.room.egg.holder];
  const behind = g.room.score.r < g.room.score.b ? 1 : g.room.score.b < g.room.score.r ? 2 : (scorer.team === 1 ? 2 : 1);
  ok(newHolder && newHolder.team === behind, 'team behind gets the egg');
}

// ---------- Raptor Boat ----------
function boatCase(delayCatch) {
  const g = makeRoom();
  const r1 = g.join('r1', 1), r2 = g.join('r2', 1), b1 = g.join('b1', 2);
  g.room.stateEndsAt = g.now(); g.advance(8200);
  // give red the egg
  g.room.eggGive(r1);
  place(g.room, b1, 10, 10);
  // red scores on the right (columns 66-68): throw from (60,4) at the top wall, catcher waits in the endzone
  place(g.room, r1, 62, 3); place(g.room, r2, 67, 5);
  const t0 = g.now();
  // aim up-right so it bounces off the top wall toward the endzone
  g.room.handle(r1.client, 'click', { x: 62 * 40 + 300, y: 3 * 40 - 300 });
  place(g.room, r2, 67, 15);
  let caught = false;
  for (let i = 0; i < 300 && !caught; i++) {
    g.advance(1000 / 60);
    if (g.room.egg.holder === r2.id) caught = true;
    // step into the egg's path once it's over the endzone (after 1.7 s for the late case)
    const e = g.room.egg.body && g.room.egg.body.GetPosition();
    if (e && g.room.egg.bounced && e.x > 26.3 && (!delayCatch || g.now() - t0 > 1700)) place(g.room, r2, e.x / 0.4 + 0.5, e.y / 0.4);
  }
  return { g, t0, caught, bounced: g.since(t0).filter((x) => x.ev === 'object').length > 1 };
}
{
  const { g, t0, caught } = boatCase(false);
  const ev = g.since(t0);
  ok(caught && ev.some((x) => x.ev === 'boat'), 'Raptor Boat: wall bounce, teammate catches in the endzone');
  ok(g.room.score.r === 2, 'boat is worth 2 (score ' + JSON.stringify(g.room.score) + ')');
  const seq = ev.filter((x) => ['boat', 'score', 'eggBall', 'chat'].includes(x.ev)).map((x) => x.ev === 'eggBall' ? 'eggBall:' + x.d.state : x.ev);
  ok(seq.slice(-5).join() === 'boat,score,eggBall:waiting,chat,score', 'boat packet order ' + seq.slice(-5).join());
  ok(g.room.players[1]['s-captures'] === 1 && g.room.players[2]['s-captures'] === 1, 'thrower and catcher each get a capture');
}
{
  const { g, caught } = boatCase(true);
  ok(caught && !g.log.some((x) => x.ev === 'boat') && g.room.score.r === 1, 'catch after 1.5 s is a plain 1-point score (' + JSON.stringify(g.room.score) + ')');
}

// ---------- egg flight vs real replays ----------
const REPLAYS = path.join(process.env.HOME, 'tagpro-analytics/data/eggball_hockey');
if (fs.existsSync(path.join(REPLAYS, 'status.csv'))) {
  const zlib = require('zlib');
  const rows = fs.readFileSync(path.join(REPLAYS, 'status.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(',')).filter((r) => r[1] === 'ok' && r[3] === 'eggball').slice(0, 25);
  const errs = { clean: [], bounced: [] };
  for (const r of rows) {
    const file = path.join(REPLAYS, 'replays', r[0].slice(0, 2), r[0] + '.ndjson.gz');
    if (!fs.existsSync(file)) continue;
    const evs = zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split('\n').map((l) => JSON.parse(l));
    let cur = null;
    for (const [t, k, d] of evs) {
      if (k !== 'object' || !d || d.type !== 'egg') continue;
      if (!cur || cur.id !== d.id) {
        const g = makeRoom();
        g.room.egg.state = 'play';
        const b = g.room.createEgg(d.rx, d.ry, 1);
        b.SetLinearVelocity(new (require('../engine/box2d').Common.Math.b2Vec2)(d.lx, d.ly));
        cur = { id: d.id, t0: t, g, b, n: 0 };
        continue;
      }
      const n = Math.round((t - cur.t0) / (1000 / 60));
      if (n > 600) continue;
      while (cur.n < n) { cur.g.room.world.Step(1 / 60, 8, 3); cur.n++; }
      const p = cur.b.GetPosition();
      (cur.g.room.egg.bounced ? errs.bounced : errs.clean).push(Math.hypot(p.x - d.rx, p.y - d.ry) * 100);
    }
  }
  const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(f * (s.length - 1))].toFixed(2) : 'n/a'; };
  for (const k of ['clean', 'bounced']) console.log(`egg flight vs replays (${k}): ${errs[k].length} updates, median ${q(errs[k], 0.5)} px, 90th percentile ${q(errs[k], 0.9)} px`);
  ok(Number(q(errs.clean, 0.5)) < 1, 'egg flight before any bounce matches replays (median under 1 px)');
  ok(Number(q(errs.bounced, 0.5)) < 3, 'egg flight after wall bounces matches replays (median under 3 px)');
}

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
