// Local trust (group setting): server accepts/rejects client-reported positions. Run: node tools/localtrust-test.js
const P = __dirname + '/../';
const { GameRoom } = require(P + 'engine/game.js');
const { loadMap, trimPng } = require(P + 'engine/mapLoader'); const { PNG } = require(P + 'node_modules/pngjs');
const fs = require('fs');
const map = loadMap(PNG.sync.read(trimPng(fs.readFileSync(P + 'maps/69860.png'))), JSON.parse(fs.readFileSync(P + 'maps/69860.json')));
let t = 0; const now = () => t;
const mk = (s) => new GameRoom({ id: 'x', map, settings: Object.assign({ ghostMode: 'noPlayerCollisions', localTrust: true }, s), now });
const room = mk({});
console.log('localTrust on:', room.localTrust, '| off w/o ghost:', mk({ ghostMode: 'disabled' }).localTrust, '| off noTeam:', mk({ ghostMode: 'noTeamCollisions' }).localTrust);
const got = [];
const client = { emit: (ev, d) => got.push([ev, d]), disconnect() {} };
const other = { emit: (ev, d) => other.got.push([ev, d]), disconnect() {}, got: [] };
room.addClient(client, { id: 's1', name: 'A' }); room.addClient(other, { id: 's2', name: 'B' });
room.state = 1; // ACTIVE
const p = room.players[client.playerId];
for (let i = 0; i < 2; i++) room.step();
const pos = p.body.GetPosition(); const x0 = pos.x, y0 = pos.y;
console.log('lte after spawn', p.lte, 'pos', x0.toFixed(2), y0.toFixed(2));
const send = (d) => client.onEvent('lt', Object.assign({ e: p.lte, vx: 0, vy: 0, a: 0, ra: 0 }, d));
// small legit move
t += 33; send({ x: x0 + 0.05, y: y0 });
console.log('legit move accepted:', Math.abs(p.body.GetPosition().x - (x0 + 0.05)) < 1e-6);
// stale epoch ignored
t += 33; client.onEvent('lt', { e: p.lte - 1, x: x0 + 0.1, y: y0, vx: 0, vy: 0, a: 0, ra: 0 });
console.log('stale epoch ignored:', Math.abs(p.body.GetPosition().x - (x0 + 0.05)) < 1e-6);
// teleport hack rejected -> snap
const lte = p.lte; t += 33; send({ x: x0 + 5, y: y0 });
console.log('jump rejected + snap:', p.body.GetPosition().x < x0 + 1, p.lte === lte + 1);
// through-wall: find nearest wall tile and aim through it
let wall = null; const tx = Math.round(x0 / 0.4), ty = Math.round(y0 / 0.4);
for (let d = 1; d < 30 && !wall; d++) if (room.tiles[tx + d] && room.tiles[tx + d][ty] === 1) wall = d;
if (wall) { t += 2000; room.trust.delete(p); p.body.SetPosition(new (require(P + 'engine/box2d').Common.Math.b2Vec2)(x0, y0)); const l2 = p.lte; send({ x: x0 + (wall + 1) * 0.4, y: y0 }); console.log('wall clip rejected:', p.lte === l2 + 1); }
// speed cap
t += 33; send({ x: p.body.GetPosition().x, y: p.body.GetPosition().y, vx: 50 }); console.log('speed hack rejected:', p.body.GetLinearVelocity().x < 50);
// snapshot stripping
got.length = 0; other.got.length = 0; t += 33; send({ x: p.body.GetPosition().x + 0.02, y: p.body.GetPosition().y, vx: 1 });
room.snapshot();
const own = got.filter(([e, d]) => e === 'p').flatMap(([, d]) => d.u).filter((o) => o.id === p.id);
const theirs = other.got.filter(([e, d]) => e === 'p').flatMap(([, d]) => d.u).filter((o) => o.id === p.id);
console.log('owner gets no own snapshot:', own.length === 0, '| others get it:', theirs.length > 0 && theirs[0].rx != null);
room.closed = true; for (const h of room.timers) clearTimeout(h);
