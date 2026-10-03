// Local trust (group setting): server accepts/rejects client-reported positions and leaves
// boosts/bombs/portals of trusted balls to their clients. Run: node tools/localtrust-test.js
const P = __dirname + '/../';
const { GameRoom } = require(P + 'engine/game.js');
const { loadMap, trimPng } = require(P + 'engine/mapLoader');
const { PNG } = require(P + 'node_modules/pngjs');
const V = require(P + 'engine/box2d').Common.Math.b2Vec2;
const fs = require('fs');
const load = (k) => loadMap(PNG.sync.read(trimPng(fs.readFileSync(P + 'maps/' + k + '.png'))), JSON.parse(fs.readFileSync(P + 'maps/' + k + '.json')));
let t = 0; const now = () => t;
let fails = 0; const check = (name, ok) => { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) fails++; };
const mk = (map, s) => new GameRoom({ id: 'x', map, settings: Object.assign({ ghostMode: 'noPlayerCollisions', localTrust: true }, s), now });
const join = (room, name) => { const c = { got: [], emit(ev, d) { this.got.push([ev, d]); }, disconnect() {} }; room.addClient(c, { id: name, name }); return c; };
const close = (room) => { room.closed = true; for (const h of room.timers) clearTimeout(h); };

const map = load('74431');
check('on with No Player Collisions', mk(map, {}).localTrust);
check('off without ghost mode', !mk(map, { ghostMode: 'disabled' }).localTrust);
check('off with No Team Collisions', !mk(map, { ghostMode: 'noTeamCollisions' }).localTrust);

const room = mk(map, {});
const a = join(room, 'A'), b = join(room, 'B');
room.state = 1; room.step(); room.step();
const p = room.players[a.playerId], q = room.players[b.playerId];
const at = (x, y) => { p.body.SetPosition(new V(x, y)); room.trust.delete(p); t += 1000; };
const send = (d) => a.onEvent('lt', Object.assign({ e: p.lte, vx: 0, vy: 0, a: 0, ra: 0 }, d));
const { x: x0, y: y0 } = p.body.GetPosition();

t += 33; send({ x: x0 + 0.05, y: y0 });
check('small move accepted', Math.abs(p.body.GetPosition().x - (x0 + 0.05)) < 1e-6 && room.isTrusted(p));
check('bot/other player not trusted until it reports', !room.isTrusted(q));
t += 33; a.onEvent('lt', { e: p.lte - 1, x: x0 + 0.1, y: y0, vx: 0, vy: 0, a: 0, ra: 0 });
check('report from before a snap ignored', Math.abs(p.body.GetPosition().x - (x0 + 0.05)) < 1e-6);
let lte = p.lte; t += 33; send({ x: x0 + 9, y: y0 });
check('teleport hack rejected + snapped', p.lte === lte + 1);
t += 33; send({ x: p.body.GetPosition().x, y: p.body.GetPosition().y, vx: 50 });
check('speed hack rejected', p.body.GetLinearVelocity().x < 50);

// wall: find a floor tile with a full wall right of it
let wall = null;
for (let x = 1; x < room.W - 2 && !wall; x++) for (let y = 1; y < room.H - 1 && !wall; y++) if (room.tiles[x][y] === 2 && room.tiles[x + 1][y] === 1 && room.tiles[x + 2][y] === 2) wall = [x, y];
if (wall) { at(wall[0] * 0.4, wall[1] * 0.4); lte = p.lte; send({ x: (wall[0] + 2) * 0.4, y: wall[1] * 0.4 }); check('move through a wall rejected', p.lte === lte + 1); }

// portal: client teleports itself, server accepts the jump without snapping
const key = Object.keys(map.portals).find((k) => map.portals[k].destination && room.tiles[k.split(',')[0]][k.split(',')[1]] === 13);
const [px, py] = key.split(',').map(Number), dest = map.portals[key].destination;
at(px * 0.4 + 0.3, py * 0.4); send({ x: px * 0.4 + 0.3, y: py * 0.4 });
lte = p.lte; t += 33; send({ x: dest.x * 0.4 + 0.05, y: dest.y * 0.4 });
check('own portal jump accepted, no snap', p.lte === lte && Math.abs(p.body.GetPosition().x - (dest.x * 0.4 + 0.05)) < 1e-6);
check('server does not teleport a trusted ball itself', (() => { at(px * 0.4, py * 0.4); send({ x: px * 0.4, y: py * 0.4 }); p.arrivedOnPortal = null; room.step(); return Math.hypot(p.body.GetPosition().x - px * 0.4, p.body.GetPosition().y - py * 0.4) < 0.1; })());

// explosions: a trusted ball gets a kick message, its server velocity is left to the client
a.got.length = 0; const v0 = p.body.GetLinearVelocity().x; const pp = p.body.GetPosition();
room.explode({ x: pp.x - 0.5, y: pp.y }, 2.8, 4, null);
const k = a.got.find(([ev]) => ev === 'ltKick');
check('explosion sends ltKick to trusted ball', k && k[1].vx > 0 && p.body.GetLinearVelocity().x === v0);
const qv = q.body.GetLinearVelocity().x; const qp = q.body.GetPosition();
room.explode({ x: qp.x - 0.5, y: qp.y }, 2.8, 4, null);
check('untrusted ball still pushed by the server', q.body.GetLinearVelocity().x > qv);

// snapshots
a.got.length = 0; b.got.length = 0; t += 33; send({ x: p.body.GetPosition().x + 0.02, y: p.body.GetPosition().y, vx: 1 });
room.snapshot();
const ids = (c) => c.got.filter(([e]) => e === 'p').flatMap(([, d]) => d.u).filter((o) => o.id === p.id);
check('trusted player gets no own snapshot', ids(a).length === 0);
check('others still get it', ids(b).length > 0 && ids(b)[0].rx != null);
check('trustConfig has portals', Object.keys(room.trustConfig().portals).length > 0);
close(room);

// gravity: trust works there too, and a trusted player's up press doesn't jump on the server
const groom = mk(map, { mode: 'gravity' });
check('on in gravity mode', groom.localTrust && groom.trustConfig().gravity.jump > 0);
const g = join(groom, 'G'); groom.state = 1; groom.step();
const gp = groom.players[g.playerId], gpos = gp.body.GetPosition();
g.onEvent('lt', { e: gp.lte, x: gpos.x, y: gpos.y, vx: 0, vy: 0, a: 0, ra: 0 });
g.onEvent('keydown', { k: 'up', t: 1 });
check('server leaves the jump to a trusted client', gp.body.GetLinearVelocity().y > -1);
for (let i = 0; i < 30; i++) groom.step();
const gnow = gp.body.GetPosition();
check('trusted ball does not drift between reports (no server gravity)', Math.abs(gnow.y - gpos.y) < 1e-9);
close(groom);

// pickups fire on the way in only: a boost that respawns under a ball waits until it leaves and returns
const broom = mk(map, { ghostMode: 'disabled' });
const bc = join(broom, 'B'); broom.state = 1; broom.step();
const bp = broom.players[bc.playerId];
let bx = -1, by = -1;
for (let x = 1; x < broom.W - 1 && bx < 0; x++) for (let y = 1; y < broom.H - 1; y++) if (broom.tiles[x][y] === 2 && broom.tiles[x + 1][y] === 2) { bx = x; by = y; break; }
broom.setTile(bx + 1, by, 5, true);
const place = (x, vx) => { bp.body.SetPosition(new V(x * 0.4, by * 0.4)); bp.body.SetLinearVelocity(new V(vx, 0)); broom.tileInteractions(bp); };
place(bx, 1);                                       // off the boost
place(bx + 1, 1);                                   // roll onto it
check('boost fires when rolling onto it', bp.body.GetLinearVelocity().x > 5);
place(bx + 1, 0.5); broom.setTile(bx + 1, by, 5, true); place(bx + 1, 0.5); // it respawns while we sit on it
check('respawned boost under the ball does not fire', bp.body.GetLinearVelocity().x < 1);
place(bx, 0.5); place(bx + 1, 0.5);                 // off and back on
check('fires again after leaving and coming back', bp.body.GetLinearVelocity().x > 5);
close(broom);
process.exit(fails ? 1 : 0);
