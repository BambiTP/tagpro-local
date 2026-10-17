// Viewport culling: a player only gets other balls' positions inside the view around their own ball.
// Run: node tools/viewport-test.js
const P = __dirname + '/../';
const { GameRoom } = require(P + 'engine/game.js');
const { loadMap, trimPng } = require(P + 'engine/mapLoader');
const { PNG } = require(P + 'node_modules/pngjs');
const V = require(P + 'engine/box2d').Common.Math.b2Vec2;
const fs = require('fs');
const load = (k) => loadMap(PNG.sync.read(trimPng(fs.readFileSync(P + 'maps/' + k + '.png'))), JSON.parse(fs.readFileSync(P + 'maps/' + k + '.json')));
let t = 0; const now = () => t;
let fails = 0; const check = (name, ok) => { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) fails++; };
const join = (room, name, opts) => { const c = { got: [], emit(ev, d) { this.got.push([ev, d]); }, disconnect() {} }; room.addClient(c, { id: name, name }, opts); return c; };
const about = (c, id) => c.got.filter(([e]) => e === 'p').flatMap(([, d]) => (Array.isArray(d) ? d : d.u)).filter((o) => o.id === id);

const room = new GameRoom({ id: 'x', map: load('74431'), settings: { ghostMode: 'noPlayerCollisions' }, now });
const a = join(room, 'A'), b = join(room, 'B'), s = join(room, 'S', { spectate: true });
room.state = 1; room.step(); room.step();
const p = room.players[a.playerId], q = room.players[b.playerId];
const put = (pl, x, y) => { pl.body.SetPosition(new V(x, y)); pl.body.SetLinearVelocity(new V(0, 0)); };
const { x, y } = p.body.GetPosition();

const clear = () => { for (const c of [a, b, s]) c.got.length = 0; };
put(q, x + 20, y); clear(); room.step(); room.snapshot();
check('far ball: no position sent', about(a, q.id).every((o) => o.rx == null));
check('spectator still gets it', about(s, q.id).some((o) => o.rx != null));

put(q, x + 3, y); clear(); room.step();
const shown = about(a, q.id).find((o) => o.draw === true);
check('ball coming into view: draw true + full position', shown && shown.rx != null && shown.ry != null);
check('the other player sees this one too', about(b, p.id).some((o) => o.draw === true && o.rx != null));

clear(); room.snapshot();
check('in view: snapshots carry its position', about(a, q.id).every((o) => !('draw' in o)));

put(q, x + 20, y); clear(); room.step();
const hid = about(a, q.id).find((o) => o.draw === false);
check('ball leaving view: draw false, no position', hid && hid.rx == null);
clear(); room.step(); room.snapshot();
check('out of view: nothing more about its position', about(a, q.id).every((o) => o.rx == null && !('draw' in o)));

q.score = 7; room.queue(q, 'score'); clear(); room.flushDirty();
check('non-position fields still sent while out of view', about(a, q.id).some((o) => o.score === 7 && o.rx == null));

const c = join(room, 'C');
const late = about(c, q.id).concat(about(c, p.id));
check('a joining player gets no far positions', late.every((o) => o.rx == null));

for (const h of room.timers) clearTimeout(h);
room.closed = true;
console.log(fails ? fails + ' failed' : 'all passed');
process.exit(fails ? 1 : 0);
